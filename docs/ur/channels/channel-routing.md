---
summary: "ہر چینل (WhatsApp، Telegram، Discord، Slack) کے لیے روٹنگ کے قواعد اور مشترکہ سیاق"
read_when:
  - چینل روٹنگ یا ان باکس کے رویّے میں تبدیلی کرتے وقت
title: "چینل روٹنگ"
---

# چینلز اور روٹنگ

OpenClaw routes replies **back to the channel where a message came from**. The
model does not choose a channel; routing is deterministic and controlled by the
host configuration.

## اہم اصطلاحات

- **Channel**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`۔
- **AccountId**: فی چینل اکاؤنٹ کی مثال (جب معاونت دستیاب ہو)۔
- **AgentId**: ایک علیحدہ ورک اسپیس + سیشن اسٹور (“دماغ”)۔
- **SessionKey**: وہ بکٹ کلید جو سیاق محفوظ کرنے اور ہم زمانی (concurrency) کو کنٹرول کرنے کے لیے استعمال ہوتی ہے۔

## سیشن کی کلید کی شکلیں (مثالیں)

براہِ راست پیغامات ایجنٹ کے **مرکزی** سیشن میں سمٹ جاتے ہیں:

- `agent:<agentId>:<mainKey>` (بطورِ طے شدہ: `agent:main:main`)

گروپس اور چینلز ہر چینل کے حساب سے علیحدہ رہتے ہیں:

- گروپس: `agent:<agentId>:<channel>:group:<id>`
- چینلز/کمرے: `agent:<agentId>:<channel>:channel:<id>`

تھریڈز:

- Slack/Discord تھریڈز بنیادی کلید کے ساتھ `:thread:<threadId>` شامل کرتے ہیں۔
- Telegram فورم موضوعات گروپ کلید میں `:topic:<topicId>` کو شامل کرتے ہیں۔

مثالیں:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## روٹنگ کے قواعد (ایجنٹ کیسے منتخب ہوتا ہے)

ہر آنے والے پیغام کے لیے روٹنگ **ایک ایجنٹ** منتخب کرتی ہے:

1. **عین ہم منصب میچ** (`bindings` کے ساتھ `peer.kind` + `peer.id`)۔
2. **گلڈ میچ** (Discord) بذریعہ `guildId`۔
3. **ٹیم میچ** (Slack) بذریعہ `teamId`۔
4. **اکاؤنٹ میچ** (چینل پر `accountId`)۔
5. **چینل میچ** (اسی چینل پر کوئی بھی اکاؤنٹ)۔
6. **ڈیفالٹ ایجنٹ** (`agents.list[].default`، ورنہ فہرست کی پہلی اندراج، اور آخرکار `main` پر فال بیک)۔

منتخب ایجنٹ یہ طے کرتا ہے کہ کون سی ورک اسپیس اور سیشن اسٹور استعمال ہوں گے۔

## براڈکاسٹ گروپس (متعدد ایجنٹس چلائیں)

براڈکاسٹ گروپس آپ کو ایک ہی ہم منصب کے لیے **متعدد ایجنٹس** چلانے دیتے ہیں **جب OpenClaw عام طور پر جواب دیتا** (مثال کے طور پر: WhatsApp گروپس میں، منشن/ایکٹیویشن گیٹنگ کے بعد)۔

کنفیگ:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

دیکھیں: [Broadcast Groups](/channels/broadcast-groups)۔

## کنفیگ کا جائزہ

- `agents.list`: نامزد ایجنٹ تعریفیں (ورک اسپیس، ماڈل، وغیرہ)۔
- `bindings`: آنے والے چینلز/اکاؤنٹس/ہم منصبوں کو ایجنٹس سے میپ کریں۔

مثال:

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },
  ],
}
```

## سیشن اسٹوریج

سیشن اسٹورز اسٹیٹ ڈائریکٹری کے تحت ہوتے ہیں (بطورِ طے شدہ `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL ٹرانسکرپٹس اسٹور کے ساتھ ہی موجود ہوتے ہیں

آپ اسٹور پاتھ کو `session.store` اور `{agentId}` ٹیمپلیٹنگ کے ذریعے اووررائیڈ کر سکتے ہیں۔

## WebChat کا رویّہ

WebChat attaches to the **selected agent** and defaults to the agent’s main
session. Because of this, WebChat lets you see cross‑channel context for that
agent in one place.

## جواب کا سیاق

آنے والے جوابات میں شامل ہوتا ہے:

- `ReplyToId`, `ReplyToBody`, اور `ReplyToSender` (جب دستیاب ہوں)۔
- حوالہ شدہ سیاق `Body` میں `[Replying to ...]` بلاک کے طور پر شامل کیا جاتا ہے۔

یہ تمام چینلز میں یکساں ہے۔
