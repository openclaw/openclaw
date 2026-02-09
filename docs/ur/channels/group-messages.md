---
summary: "WhatsApp گروپ پیغامات کی ہینڈلنگ کے لیے رویّہ اور کنفیگ (mentionPatterns تمام سرفیسز میں مشترک ہیں)"
read_when:
  - گروپ پیغام کے قواعد یا مینشنز تبدیل کرتے وقت
title: "گروپ پیغامات"
---

# گروپ پیغامات (WhatsApp ویب چینل)

مقصد: Clawd کو WhatsApp گروپس میں موجود رہنے دینا، صرف پنگ ہونے پر بیدار کرنا، اور اس تھریڈ کو ذاتی DM سیشن سے الگ رکھنا۔

Note: `agents.list[].groupChat.mentionPatterns` is now used by Telegram/Discord/Slack/iMessage as well; this doc focuses on WhatsApp-specific behavior. For multi-agent setups, set `agents.list[].groupChat.mentionPatterns` per agent (or use `messages.groupChat.mentionPatterns` as a global fallback).

## کیا نافذ ہے (2025-12-03)

- Activation modes: `mention` (default) or `always`. `mention` requires a ping (real WhatsApp @-mentions via `mentionedJids`, regex patterns, or the bot’s E.164 anywhere in the text). `always` wakes the agent on every message but it should reply only when it can add meaningful value; otherwise it returns the silent token `NO_REPLY`. Defaults can be set in config (`channels.whatsapp.groups`) and overridden per group via `/activation`. When `channels.whatsapp.groups` is set, it also acts as a group allowlist (include `"*"` to allow all).
- Group policy: `channels.whatsapp.groupPolicy` controls whether group messages are accepted (`open|disabled|allowlist`). `allowlist` uses `channels.whatsapp.groupAllowFrom` (fallback: explicit `channels.whatsapp.allowFrom`). Default is `allowlist` (blocked until you add senders).
- Per-group sessions: session keys look like `agent:<agentId>:whatsapp:group:<jid>` so commands such as `/verbose on` or `/think high` (sent as standalone messages) are scoped to that group; personal DM state is untouched. Heartbeats are skipped for group threads.
- Context injection: **pending-only** group messages (default 50) that _did not_ trigger a run are prefixed under `[Chat messages since your last reply - for context]`, with the triggering line under `[Current message - respond to this]`. Messages already in the session are not re-injected.
- بھیجنے والے کی نمایاں شناخت: ہر گروپ بیچ اب `[from: Sender Name (+E164)]` پر ختم ہوتا ہے تاکہ Pi کو معلوم ہو کہ کون بول رہا ہے۔
- عارضی/ویو-ونس: متن/مینشن نکالنے سے پہلے ہم انہیں اَن ریپ کر دیتے ہیں، اس لیے ان کے اندر موجود پنگز بھی ٹرگر کریں گے۔
- Group system prompt: on the first turn of a group session (and whenever `/activation` changes the mode) we inject a short blurb into the system prompt like `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` If metadata isn’t available we still tell the agent it’s a group chat.

## کنفیگ مثال (WhatsApp)

`~/.openclaw/openclaw.json` میں `groupChat` بلاک شامل کریں تاکہ ڈسپلے-نام پنگز اس وقت بھی کام کریں جب WhatsApp متن کے باڈی میں بصری `@` ہٹا دے:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

نوٹس:

- regex پیٹرنز کیس اِن سینسِٹو ہیں؛ یہ `@openclaw` جیسا ڈسپلے-نام پنگ اور `+`/اسپیسز کے ساتھ یا بغیر خام نمبر دونوں کو کور کرتے ہیں۔
- جب کوئی رابطہ ٹیپ کرتا ہے تو WhatsApp اب بھی `mentionedJids` کے ذریعے کینونیکل مینشنز بھیجتا ہے، اس لیے نمبر فال بیک شاذ و نادر ہی درکار ہوتا ہے مگر ایک مفید حفاظتی جال ہے۔

### ایکٹیویشن کمانڈ (صرف مالک)

گروپ چیٹ کمانڈ استعمال کریں:

- `/activation mention`
- `/activation always`

Only the owner number (from `channels.whatsapp.allowFrom`, or the bot’s own E.164 when unset) can change this. Send `/status` as a standalone message in the group to see the current activation mode.

## استعمال کیسے کریں

1. اپنے WhatsApp اکاؤنٹ (جس پر OpenClaw چل رہا ہو) کو گروپ میں شامل کریں۔
2. Say `@openclaw …` (or include the number). Only allowlisted senders can trigger it unless you set `groupPolicy: "open"`.
3. ایجنٹ پرامپٹ میں حالیہ گروپ سیاق شامل ہوگا اور آخر میں `[from: …]` مارکر ہوگا تاکہ وہ درست شخص کو مخاطب کر سکے۔
4. Session-level directives (`/verbose on`, `/think high`, `/new` or `/reset`, `/compact`) apply only to that group’s session; send them as standalone messages so they register. Your personal DM session remains independent.

## جانچ / تصدیق

- دستی اسموک:
  - گروپ میں `@openclaw` پنگ بھیجیں اور اس بات کی تصدیق کریں کہ جواب بھیجنے والے کے نام کا حوالہ دیتا ہے۔
  - دوسرا پنگ بھیجیں اور تصدیق کریں کہ ہسٹری بلاک شامل ہوتا ہے پھر اگلی باری پر صاف ہو جاتا ہے۔
- گیٹ وے لاگز چیک کریں ( `--verbose` کے ساتھ چلائیں) تاکہ `from: <groupJid>` اور `[from: …]` سفکس دکھانے والی `inbound web message` انٹریز نظر آئیں۔

## معلوم امور

- شور سے بھرپور براڈکاسٹس سے بچنے کے لیے گروپس کے لیے ہارٹ بیٹس جان بوجھ کر چھوڑ دیے جاتے ہیں۔
- ایکو سپریشن مشترکہ بیچ اسٹرنگ استعمال کرتی ہے؛ اگر آپ بغیر مینشن کے ایک ہی متن دو بار بھیجیں تو صرف پہلی بار جواب آئے گا۔
- سیشن اسٹور میں اندراجات `agent:<agentId>:whatsapp:group:<jid>` کے طور پر ظاہر ہوں گی (بطورِ طے شدہ `~/.openclaw/agents/<agentId>/sessions/sessions.json`)؛ اندراج کا نہ ہونا صرف یہ معنی رکھتا ہے کہ گروپ نے ابھی تک رن ٹرگر نہیں کیا۔
- گروپس میں ٹائپنگ اشارے `agents.defaults.typingMode` کی پیروی کرتے ہیں (ڈیفالٹ: بغیر مینشن `message`)۔
