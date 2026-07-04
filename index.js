// ═══════════════════════════════════════════════
// BINGO CASH — index.js (Vercel Serverless)
// Sab kuch ek file mein: DB + APIs + Bot Webhook
// ═══════════════════════════════════════════════
import mongoose from 'mongoose';

const MONGO_URI  = process.env.MONGO_URI;
const BOT_TOKEN  = 8613460727:AAEorE5uRswjDPKgfvk8yADDm3dDkUMHuNg;
const APP_URL    = process.env.APP_URL || '';
const ADMIN_PASS_ENV = process.env.ADMIN_PASS || 'admin123';

// ─── MongoDB Connection (cached for serverless) ───
let cached = global._mongoose || (global._mongoose = { conn: null, promise: null });
async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) cached.promise = mongoose.connect(MONGO_URI, { bufferCommands: false });
  cached.conn = await cached.promise;
  return cached.conn;
}

// ─── SCHEMAS ───
const UserSchema = new mongoose.Schema({
  tgId:        { type: String, required: true, unique: true },
  firstName:   String, lastName: String,
  username:    String, displayName: String, langCode: String,
  balance:     { type: Number, default: 0 },
  upi:         { type: String, default: '' },
  referrals:   [String],
  referredBy:  { type: String, default: null },
  transactions: [{
    type: String, amount: Number,
    fromId: String, fromName: String,
    code: String, upi: String, status: String,
    date: { type: Date, default: Date.now }
  }],
  banned:   { type: Boolean, default: false },
  joinedAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now }
});
const SettingsSchema  = new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed });
const WithdrawalSchema = new mongoose.Schema({ tgId: String, name: String, amount: Number, upi: String, status: { type: String, default: 'pending' }, date: { type: Date, default: Date.now } });
const GiftCodeSchema  = new mongoose.Schema({ code: { type: String, unique: true }, amount: Number, maxUses: { type: Number, default: 0 }, uses: { type: Number, default: 0 }, usedBy: [String], created: { type: Date, default: Date.now } });
const ChannelSchema   = new mongoose.Schema({ type: String, name: String, link: String, icon: String, order: { type: Number, default: 0 } });
const ChatSchema      = new mongoose.Schema({ tgId: String, from: String, msg: String, date: { type: Date, default: Date.now } });
const ActivitySchema  = new mongoose.Schema({ text: String, date: { type: Date, default: Date.now } });

const User       = mongoose.models.User       || mongoose.model('User', UserSchema);
const Settings   = mongoose.models.Settings   || mongoose.model('Settings', SettingsSchema);
const Withdrawal = mongoose.models.Withdrawal || mongoose.model('Withdrawal', WithdrawalSchema);
const GiftCode   = mongoose.models.GiftCode   || mongoose.model('GiftCode', GiftCodeSchema);
const Channel    = mongoose.models.Channel    || mongoose.model('Channel', ChannelSchema);
const Chat       = mongoose.models.Chat       || mongoose.model('Chat', ChatSchema);
const Activity   = mongoose.models.Activity   || mongoose.model('Activity', ActivitySchema);

// ─── HELPERS ───
async function getSetting(key, def) {
  const s = await Settings.findOne({ key });
  return s ? s.value : def;
}
async function setSetting(key, value) {
  await Settings.findOneAndUpdate({ key }, { value }, { upsert: true });
}
async function logActivity(text) {
  await Activity.create({ text });
  const count = await Activity.countDocuments();
  if (count > 100) {
    const old = await Activity.find().sort({ date: 1 }).limit(count - 100);
    await Activity.deleteMany({ _id: { $in: old.map(o => o._id) } });
  }
}
async function initDefaults() {
  const defaults = {
    botOn: true, wdOn: true, gateOn: true,
    minWd: 50, maxWd: 10000, refAmt: 5,
    wdApiUrl: '', wdApiKey: '',
    botName: 'BingoWebApp_Bot',
    adminPass: ADMIN_PASS_ENV,
    payChN: '', payChL: ''
  };
  for (const [key, value] of Object.entries(defaults)) {
    const ex = await Settings.findOne({ key });
    if (!ex) await Settings.create({ key, value });
  }
}

// ─── TELEGRAM HELPER ───
async function tgSend(chatId, text, extra = {}) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra })
  });
}

// ─── CORS HEADERS ───
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-pass');
}

// ═══════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════
export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  await connectDB();
  await initDefaults();

  const url    = req.url || '';
  const action = req.query?.action || '';
  const method = req.method;
  const body   = req.body || {};

  // ════════════════════════════════
  // TELEGRAM WEBHOOK — /api/webhook
  // ════════════════════════════════
  if (url.startsWith('/api/webhook')) {
    res.status(200).end();
    if (method !== 'POST') return;

    const { message } = body;
    if (!message) return;

    const chatId    = message.chat.id;
    const userId    = String(message.from.id);
    const text      = message.text || '';
    const firstName = message.from.first_name || 'User';

    if (text.startsWith('/start')) {
      const startParam = text.split(' ')[1] || null;

      let user = await User.findOne({ tgId: userId });
      if (!user) {
        const displayName = [message.from.first_name, message.from.last_name].filter(Boolean).join(' ') || message.from.username || 'User';
        user = await User.create({ tgId: userId, firstName: message.from.first_name || '', lastName: message.from.last_name || '', username: message.from.username || '', displayName, langCode: message.from.language_code || 'en' });
        await logActivity('🆕 New user: ' + displayName + ' (' + userId + ')');

        if (startParam && startParam !== userId) {
          const referrer = await User.findOne({ tgId: startParam });
          if (referrer) {
            const refAmt = await getSetting('refAmt', 5);
            referrer.balance += refAmt;
            referrer.referrals.push(userId);
            referrer.transactions.push({ type: 'referral', amount: refAmt, fromId: userId, fromName: displayName });
            await referrer.save();
            user.referredBy = startParam; await user.save();
            await logActivity('💚 ' + referrer.displayName + ' earned ₹' + refAmt + ' from ' + displayName);
            await tgSend(startParam, `🎉 <b>Naya referral!</b>\n\n👤 <b>${displayName}</b> join hua!\n💰 <b>₹${refAmt}</b> tumhare wallet mein add ho gaya!`);
          }
        }
      } else {
        user.lastSeen = new Date(); await user.save();
      }

      const botOn  = await getSetting('botOn', true);
      const refAmt = await getSetting('refAmt', 5);
      if (!botOn) { await tgSend(chatId, '🔴 <b>Bot abhi offline hai.</b>\nThodi der baad try karo.'); return; }

      await tgSend(chatId,
        `👑 <b>Hey ${firstName}! Welcome To Bingo Cash!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `💰 <b>Bingo Cash kya hai?</b>\n` +
        `Real paise kamane ka sabse aasaan tarika!\n\n` +
        `🚀 <b>Kaise kamao?</b>\n` +
        `• 👥 Dosto ko refer karo — <b>₹${refAmt} per invite</b>\n` +
        `• 🎁 Gift codes redeem karo\n` +
        `• 💸 UPI pe turant withdraw karo\n\n` +
        `🏆 Top earners <b>Hall of Fame</b> mein dikhte hain!\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👇 <b>Button dabao aur abhi shuru karo!</b>`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💰 Open Bingo Cash', web_app: { url: APP_URL } }],
              [{ text: '👥 Refer & Earn', web_app: { url: APP_URL + '#earn' } }, { text: '🏆 Leaderboard', web_app: { url: APP_URL + '#rank' } }],
              [{ text: '🎁 Gift Codes', web_app: { url: APP_URL + '#gift' } }]
            ]
          }
        }
      );
      return;
    }

    if (text === '/balance') {
      const user = await User.findOne({ tgId: userId });
      if (!user) { await tgSend(chatId, '❌ Pehle /start karo!'); return; }
      await tgSend(chatId,
        `💰 <b>Tumhara Balance</b>\n\n💵 Balance: <b>₹${parseFloat(user.balance).toFixed(2)}</b>\n👥 Referrals: <b>${user.referrals.length}</b>\n🆔 TG ID: <code>${userId}</code>`,
        { reply_markup: { inline_keyboard: [[{ text: '💰 App Kholo', web_app: { url: APP_URL } }]] } }
      );
      return;
    }

    if (text === '/help') {
      await tgSend(chatId,
        `🆘 <b>Bingo Cash Help</b>\n\n/start — App open karo\n/balance — Balance dekho\n/help — Help\n\n❓ Problem? App mein admin se baat karo.`,
        { reply_markup: { inline_keyboard: [[{ text: '💰 Open Bingo Cash', web_app: { url: APP_URL } }]] } }
      );
      return;
    }
    return;
  }

  // ════════════════════════════════
  // USER INIT — POST /api/user?action=init
  // ════════════════════════════════
  if (url.startsWith('/api/user') && action === 'init' && method === 'POST') {
    const { tgId, firstName, lastName, username, displayName, langCode, startParam } = body;
    if (!tgId) return res.json({ ok: false, error: 'tgId required' });

    const botOn = await getSetting('botOn', true);
    if (!botOn) return res.json({ ok: false, error: 'BOT_OFF' });

    let user = await User.findOne({ tgId });
    if (!user) {
      user = await User.create({ tgId, firstName, lastName, username, displayName, langCode });
      await logActivity('🆕 New user: ' + displayName + ' (' + tgId + ')');
      if (startParam && startParam !== tgId) {
        const ref = await User.findOne({ tgId: startParam });
        if (ref) {
          const refAmt = await getSetting('refAmt', 5);
          ref.balance += refAmt;
          ref.referrals.push(tgId);
          ref.transactions.push({ type: 'referral', amount: refAmt, fromId: tgId, fromName: displayName });
          await ref.save();
          user.referredBy = startParam; await user.save();
          await logActivity('💚 ' + ref.displayName + ' earned ₹' + refAmt + ' from ' + displayName);
        }
      }
    } else {
      user.firstName = firstName; user.lastName = lastName;
      user.username = username; user.displayName = displayName;
      user.lastSeen = new Date(); await user.save();
    }

    if (user.banned) return res.json({ ok: false, error: 'BANNED' });

    const allS = await Settings.find({});
    const settings = {}; allS.forEach(s => settings[s.key] = s.value);
    const channels = await Channel.find({}).sort({ order: 1 });
    const chats    = await Chat.find({ tgId }).sort({ date: 1 }).limit(50);
    return res.json({ ok: true, user, settings, channels, chats });
  }

  // USER GET — GET /api/user?action=get&tgId=xxx
  if (url.startsWith('/api/user') && action === 'get' && method === 'GET') {
    const tgId = req.query.tgId;
    const user = await User.findOne({ tgId });
    if (!user) return res.status(404).json({ ok: false });
    return res.json({ ok: true, user });
  }

  // USER UPI — POST /api/user?action=upi
  if (url.startsWith('/api/user') && action === 'upi' && method === 'POST') {
    await User.findOneAndUpdate({ tgId: body.tgId }, { upi: body.upi });
    return res.json({ ok: true });
  }

  // RANK — GET /api/user?action=rank
  if (url.startsWith('/api/user') && action === 'rank' && method === 'GET') {
    const users = await User.find({}, 'tgId displayName referrals').sort({ referrals: -1 });
    return res.json({ ok: true, rank: users.map(u => ({ tgId: u.tgId, displayName: u.displayName, invites: u.referrals.length })) });
  }

  // ════════════════════════════════
  // GIFT — POST /api/gift
  // ════════════════════════════════
  if (url.startsWith('/api/gift') && method === 'POST') {
    const { tgId, code } = body;
    const gc = await GiftCode.findOne({ code: (code || '').toUpperCase() });
    if (!gc) return res.json({ ok: false, error: 'INVALID_CODE' });
    if (gc.usedBy.includes(tgId)) return res.json({ ok: false, error: 'ALREADY_CLAIMED' });
    if (gc.maxUses > 0 && gc.uses >= gc.maxUses) return res.json({ ok: false, error: 'EXPIRED' });
    gc.uses++; gc.usedBy.push(tgId); await gc.save();
    const user = await User.findOne({ tgId });
    user.balance += gc.amount;
    user.transactions.push({ type: 'gift', amount: gc.amount, code: gc.code });
    await user.save();
    await logActivity('🎁 ' + user.displayName + ' claimed ₹' + gc.amount + ' (' + gc.code + ')');
    return res.json({ ok: true, amount: gc.amount, balance: user.balance });
  }

  // ════════════════════════════════
  // WITHDRAW — POST /api/withdraw
  // ════════════════════════════════
  if (url.startsWith('/api/withdraw') && method === 'POST') {
    const { tgId, amount, upi } = body;
    const wdOn = await getSetting('wdOn', true);
    if (!wdOn) return res.json({ ok: false, error: 'WD_OFF' });
    const minWd = await getSetting('minWd', 50);
    const maxWd = await getSetting('maxWd', 10000);
    const user = await User.findOne({ tgId });
    if (!user) return res.json({ ok: false, error: 'USER_NOT_FOUND' });
    if (amount < minWd) return res.json({ ok: false, error: 'MIN_WD', min: minWd });
    if (amount > maxWd) return res.json({ ok: false, error: 'MAX_WD', max: maxWd });
    if (amount > user.balance) return res.json({ ok: false, error: 'LOW_BALANCE' });
    user.balance -= amount; user.upi = upi;
    user.transactions.push({ type: 'withdrawal', amount: -amount, upi, status: 'pending' });
    await user.save();
    const wd = await Withdrawal.create({ tgId, name: user.displayName, amount, upi });
    await logActivity('💸 ' + user.displayName + ' withdrew ₹' + amount + ' to ' + upi);
    // Payout API
    const wdApiUrl = await getSetting('wdApiUrl', '');
    const wdApiKey = await getSetting('wdApiKey', '');
    if (wdApiUrl) {
      try {
        await fetch(wdApiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + wdApiKey }, body: JSON.stringify({ tgId, name: user.displayName, amount, upi, id: wd._id }) });
      } catch(e) {}
    }
    return res.json({ ok: true, balance: user.balance });
  }

  // ════════════════════════════════
  // ADMIN ROUTES — /api/admin
  // ════════════════════════════════
  if (url.startsWith('/api/admin')) {

    // Login — no auth needed
    if (action === 'login' && method === 'POST') {
      const adminPass = await getSetting('adminPass', ADMIN_PASS_ENV);
      if (body.password !== adminPass) return res.json({ ok: false, error: 'Wrong password' });
      return res.json({ ok: true });
    }

    // Auth check
    const adminPass = await getSetting('adminPass', ADMIN_PASS_ENV);
    const pass = req.headers['x-admin-pass'];
    if (pass !== adminPass) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    // Dashboard
    if (action === 'dashboard' && method === 'GET') {
      const users     = await User.countDocuments();
      const balAgg    = await User.aggregate([{ $group: { _id: null, total: { $sum: '$balance' } } }]);
      const pendingWd = await Withdrawal.countDocuments({ status: 'pending' });
      const refAgg    = await User.aggregate([{ $group: { _id: null, total: { $sum: { $size: '$referrals' } } } }]);
      const activity  = await Activity.find({}).sort({ date: -1 }).limit(20);
      return res.json({ ok: true, stats: { users, totalBalance: balAgg[0]?.total || 0, pendingWd, totalRefs: refAgg[0]?.total || 0 }, activity: activity.map(a => a.text) });
    }

    // Settings GET
    if (action === 'settings' && method === 'GET') {
      const all = await Settings.find({});
      const obj = {}; all.forEach(s => obj[s.key] = s.value);
      return res.json({ ok: true, settings: obj });
    }

    // Settings SAVE
    if (action === 'settings' && method === 'POST') {
      for (const [k, v] of Object.entries(body)) await setSetting(k, v);
      return res.json({ ok: true });
    }

    // Users GET
    if (action === 'users' && method === 'GET') {
      const q = req.query.q || '';
      const filter = q ? { $or: [{ displayName: new RegExp(q, 'i') }, { tgId: q }, { username: new RegExp(q, 'i') }] } : {};
      const users = await User.find(filter).sort({ joinedAt: -1 });
      return res.json({ ok: true, users });
    }

    // Ban/Unban
    if (action === 'ban' && method === 'POST') {
      const user = await User.findOne({ tgId: body.tgId });
      if (!user) return res.json({ ok: false });
      user.banned = !user.banned; await user.save();
      await logActivity((user.banned ? '🚫 ' : '✅ ') + user.displayName + (user.banned ? ' banned' : ' unbanned'));
      return res.json({ ok: true, banned: user.banned });
    }

    // Balance Edit / Reset
    if (action === 'balance' && method === 'POST') {
      const user = await User.findOne({ tgId: body.tgId });
      if (!user) return res.json({ ok: false });
      if (body.reset) {
        user.transactions.push({ type: 'admin_debit', amount: -user.balance });
        await logActivity('🔄 ' + user.displayName + ' balance reset ₹0');
        user.balance = 0;
      } else {
        user.balance = Math.max(0, user.balance + body.amount);
        user.transactions.push({ type: body.amount >= 0 ? 'admin_credit' : 'admin_debit', amount: body.amount });
        await logActivity((body.amount >= 0 ? '⬆️ ' : '⬇️ ') + 'Admin ' + (body.amount >= 0 ? 'added' : 'deducted') + ' ₹' + Math.abs(body.amount) + ' for ' + user.displayName);
      }
      await user.save();
      return res.json({ ok: true, balance: user.balance });
    }

    // Withdrawals GET
    if (action === 'withdrawals' && method === 'GET') {
      const wds = await Withdrawal.find({}).sort({ date: -1 });
      return res.json({ ok: true, withdrawals: wds });
    }

    // Withdrawal Approve/Reject
    if (action === 'wd-action' && method === 'POST') {
      const wd = await Withdrawal.findById(body.id);
      if (!wd) return res.json({ ok: false });
      wd.status = body.act === 'approve' ? 'approved' : 'rejected'; await wd.save();
      if (wd.status === 'rejected') {
        const user = await User.findOne({ tgId: wd.tgId });
        if (user) { user.balance += wd.amount; await user.save(); }
        await tgSend(wd.tgId, `❌ <b>Withdrawal Rejected</b>\n\n₹${wd.amount} wapas aapke wallet mein add ho gaya.`);
      } else {
        await tgSend(wd.tgId, `✅ <b>Withdrawal Approved!</b>\n\n₹${wd.amount} aapke <b>${wd.upi}</b> pe bhej diya gaya!`);
      }
      await logActivity((body.act === 'approve' ? '✅' : '❌') + ' ₹' + wd.amount + ' withdrawal ' + body.act + 'd for ' + wd.name);
      return res.json({ ok: true });
    }

    // Channels GET
    if (action === 'channels' && method === 'GET') {
      return res.json({ ok: true, channels: await Channel.find({}).sort({ order: 1 }) });
    }

    // Channel ADD
    if (action === 'channels' && method === 'POST') {
      const ch = await Channel.create(body);
      return res.json({ ok: true, channel: ch });
    }

    // Channel DELETE
    if (action === 'channels' && method === 'DELETE') {
      await Channel.findByIdAndDelete(body.id);
      return res.json({ ok: true });
    }

    // Gift Codes GET
    if (action === 'giftcodes' && method === 'GET') {
      return res.json({ ok: true, codes: await GiftCode.find({}).sort({ created: -1 }) });
    }

    // Gift Code CREATE
    if (action === 'giftcodes' && method === 'POST') {
      try {
        const gc = await GiftCode.create({ ...body, code: body.code.toUpperCase() });
        return res.json({ ok: true, giftCode: gc });
      } catch(e) { return res.json({ ok: false, error: 'Code already exists' }); }
    }

    // Gift Code DELETE
    if (action === 'giftcodes' && method === 'DELETE') {
      await GiftCode.findOneAndDelete({ code: body.code });
      return res.json({ ok: true });
    }

    // Broadcast
    if (action === 'broadcast' && method === 'POST') {
      const { msg } = body;
      const users = await User.find({}, 'tgId');
      await Chat.insertMany(users.map(u => ({ tgId: u.tgId, from: 'admin', msg })));
      await logActivity('📣 Broadcast sent to ' + users.length + ' users');
      // TG Bot se real message bhejo
      if (BOT_TOKEN) {
        for (const u of users) {
          try {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: u.tgId, text: '📣 ' + msg, parse_mode: 'HTML' }) });
            await new Promise(r => setTimeout(r, 50));
          } catch(e) {}
        }
      }
      return res.json({ ok: true, count: users.length });
    }

    // Chat GET
    if (action === 'chat' && method === 'GET') {
      const msgs = await Chat.find({ tgId: req.query.tgId }).sort({ date: 1 }).limit(100);
      return res.json({ ok: true, messages: msgs });
    }

    // Chat SEND (admin → user)
    if (action === 'chat' && method === 'POST') {
      const { tgId, msg } = body;
      await Chat.create({ tgId, from: 'admin', msg });
      const user = await User.findOne({ tgId });
      if (BOT_TOKEN) {
        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: tgId, text: '💬 <b>Admin ka message:</b>\n\n' + msg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💰 App Kholo', web_app: { url: APP_URL } }]] } }) });
        } catch(e) {}
      }
      await logActivity('💬 Admin messaged ' + (user?.displayName || tgId));
      return res.json({ ok: true });
    }
  }

  return res.status(404).json({ ok: false, error: 'Not found' });
}
