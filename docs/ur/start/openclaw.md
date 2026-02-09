---
summary: "حفاظتی احتیاطوں کے ساتھ OpenClaw کو ذاتی معاون کے طور پر چلانے کی مکمل رہنمائی"
read_when:
  - نئے معاون انسٹینس کی آن بورڈنگ کے وقت
  - سکیورٹی/اجازتوں کے اثرات کا جائزہ لیتے وقت
title: "ذاتی معاون سیٹ اپ"
---

# OpenClaw کے ساتھ ذاتی معاون بنانا

OpenClaw **Pi** ایجنٹس کے لیے WhatsApp + Telegram + Discord + iMessage گیٹ وے ہے۔ پلگ انز Mattermost شامل کرتے ہیں۔ یہ گائیڈ "پرسنل اسسٹنٹ" سیٹ اپ ہے: ایک مخصوص WhatsApp نمبر جو آپ کے ہمیشہ آن ایجنٹ کی طرح برتاؤ کرتا ہے۔

## ⚠️ حفاظت سب سے پہلے

آپ ایک ایجنٹ کو ایسی پوزیشن میں رکھ رہے ہیں کہ وہ:

- آپ کی مشین پر کمانڈز چلا سکے (آپ کے Pi ٹول سیٹ اپ پر منحصر)
- آپ کے ورک اسپیس میں فائلیں پڑھ/لکھ سکے
- WhatsApp/Telegram/Discord/Mattermost (پلگ اِن) کے ذریعے پیغامات واپس بھیج سکے

احتیاط سے آغاز کریں:

- ہمیشہ `channels.whatsapp.allowFrom` سیٹ کریں (اپنے ذاتی Mac پر کبھی بھی کھلی دنیا کے لیے نہ چلائیں)۔
- معاون کے لیے ایک مخصوص WhatsApp نمبر استعمال کریں۔
- ہارٹ بیٹس اب ڈیفالٹ کے طور پر ہر 30 منٹ بعد ہوتی ہیں۔ سیٹ اپ پر اعتماد ہونے تک `agents.defaults.heartbeat.every: "0m"` سیٹ کر کے غیر فعال کریں۔

## پیشگی تقاضے

- OpenClaw انسٹال اور آن بورڈ ہو — اگر ابھی تک نہیں کیا تو [Getting Started](/start/getting-started) دیکھیں
- معاون کے لیے دوسرا فون نمبر (SIM/eSIM/پری پیڈ)

## دو فون والا سیٹ اپ (سفارش کردہ)

آپ یہ چاہتے ہیں:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

اگر آپ اپنا ذاتی WhatsApp OpenClaw سے جوڑتے ہیں، تو آپ کو آنے والا ہر پیغام “ایجنٹ اِن پُٹ” بن جاتا ہے۔ یہ شاذ و نادر ہی وہ ہوتا ہے جو آپ چاہتے ہیں۔

## 5 منٹ کا فوری آغاز

1. WhatsApp Web کو جوڑیں (QR دکھاتا ہے؛ معاون فون سے اسکین کریں):

```bash
openclaw channels login
```

2. Gateway شروع کریں (چلتا رہنے دیں):

```bash
openclaw gateway --port 18789
```

3. `~/.openclaw/openclaw.json` میں کم از کم کنفیگ رکھیں:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

اب اجازت فہرست میں شامل فون سے معاون نمبر پر پیغام بھیجیں۔

آن بورڈنگ مکمل ہونے پر، ہم خودکار طور پر ڈیش بورڈ کھولتے ہیں اور ایک صاف (غیر ٹوکَنائزڈ) لنک پرنٹ کرتے ہیں۔ اگر یہ آتھنٹیکیشن مانگے، تو `gateway.auth.token` سے ٹوکَن Control UI سیٹنگز میں پیسٹ کریں۔ بعد میں دوبارہ کھولنے کے لیے: `openclaw dashboard`۔

## ایجنٹ کو ورک اسپیس دیں (AGENTS)

OpenClaw اپنی آپریٹنگ ہدایات اور “میموری” ورک اسپیس ڈائریکٹری سے پڑھتا ہے۔

ڈیفالٹ طور پر، OpenClaw ایجنٹ ورک اسپیس کے طور پر `~/.openclaw/workspace` استعمال کرتا ہے، اور سیٹ اپ/پہلی ایجنٹ رن پر اسے (اور ابتدائی `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) خودکار طور پر بنا دے گا۔ `BOOTSTRAP.md` صرف اس وقت بنایا جاتا ہے جب ورک اسپیس بالکل نیا ہو (اسے حذف کرنے کے بعد دوبارہ نہیں آنا چاہیے)۔ `MEMORY.md` اختیاری ہے (خودکار طور پر نہیں بنتا)؛ جب موجود ہو تو عام سیشنز کے لیے لوڈ کیا جاتا ہے۔ سب ایجنٹ سیشنز میں صرف `AGENTS.md` اور `TOOLS.md` شامل کیے جاتے ہیں۔

1. ٹِپ: اس فولڈر کو OpenClaw کی “یادداشت” کی طرح سمجھیں اور اسے ایک git repo بنائیں (بہتر ہے کہ پرائیویٹ ہو) تاکہ آپ کی `AGENTS.md` + میموری فائلز بیک اپ ہو جائیں۔ 2. اگر git انسٹال ہے تو بالکل نئے ورک اسپیس خودکار طور پر initialize ہو جاتے ہیں۔

```bash
openclaw setup
```

مکمل ورک اسپیس لے آؤٹ + بیک اپ گائیڈ: [Agent workspace](/concepts/agent-workspace)
میموری ورک فلو: [Memory](/concepts/memory)

اختیاری: `agents.defaults.workspace` کے ساتھ مختلف ورک اسپیس منتخب کریں ( `~` کو سپورٹ کرتا ہے)۔

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

اگر آپ پہلے ہی اپنی ورک اسپیس فائلیں کسی ریپو سے بھیجتے ہیں تو بوٹسٹرَیپ فائل کری ایشن مکمل طور پر غیر فعال کر سکتے ہیں:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## وہ کنفیگ جو اسے “ایک معاون” بناتی ہے

OpenClaw بطورِ طے شدہ ایک اچھا معاون سیٹ اپ رکھتا ہے، مگر عموماً آپ یہ چیزیں ٹیون کرنا چاہیں گے:

- `SOUL.md` میں پرسونا/ہدایات
- سوچنے کی ڈیفالٹس (اگر چاہیں)
- ہارٹ بیٹس (جب اس پر اعتماد ہو جائے)

مثال:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## سیشنز اور میموری

- سیشن فائلیں: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- سیشن میٹا ڈیٹا (ٹوکن استعمال، آخری روٹ، وغیرہ): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (لیگیسی: `~/.openclaw/sessions/sessions.json`)
- 3. `/new` یا `/reset` اس چیٹ کے لیے ایک نیا سیشن شروع کرتا ہے (جسے `resetTriggers` کے ذریعے کنفیگر کیا جا سکتا ہے)۔ 4. اگر اکیلا بھیجا جائے تو ایجنٹ ری سیٹ کی تصدیق کے لیے ایک مختصر ہیلو کے ساتھ جواب دیتا ہے۔
- `/compact [instructions]` سیشن سیاق کو کمپیکٹ کرتا ہے اور باقی سیاق بجٹ رپورٹ کرتا ہے۔

## ہارٹ بیٹس (پروایکٹو موڈ)

5. ڈیفالٹ طور پر، OpenClaw ہر 30 منٹ بعد درج ذیل پرامپٹ کے ساتھ ایک heartbeat چلاتا ہے:
   `Read HEARTBEAT.md if it exists (workspace context). 6. اس پر سختی سے عمل کریں۔ 7. پچھلی چیٹس سے پرانے کام اخذ نہ کریں اور نہ ہی دہرائیں۔ 8. اگر کسی چیز پر توجہ درکار نہ ہو تو HEARTBEAT_OK کے ساتھ جواب دیں۔`

- اگر `HEARTBEAT.md` موجود ہو مگر مؤثر طور پر خالی ہو (صرف خالی لائنیں اور مارک ڈاؤن ہیڈرز جیسے `# Heading`)، تو OpenClaw API کالز بچانے کے لیے ہارٹ بیٹ رن چھوڑ دیتا ہے۔
- اگر فائل غائب ہو تو ہارٹ بیٹ پھر بھی چلتا ہے اور ماڈل فیصلہ کرتا ہے کہ کیا کرنا ہے۔
- اگر ایجنٹ `HEARTBEAT_OK` کے ساتھ جواب دے (اختیاری مختصر پیڈنگ کے ساتھ؛ `agents.defaults.heartbeat.ackMaxChars` دیکھیں)، تو OpenClaw اس ہارٹ بیٹ کے لیے آؤٹ باؤنڈ ڈیلیوری دبا دیتا ہے۔
- ہارٹ بیٹس مکمل ایجنٹ ٹرنز چلاتے ہیں — کم وقفے زیادہ ٹوکنز جلاتے ہیں۔

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## میڈیا اِن اور آؤٹ

اِن باؤنڈ اٹیچمنٹس (تصاویر/آڈیو/دستاویزات) ٹیمپلیٹس کے ذریعے آپ کی کمانڈ تک لائے جا سکتے ہیں:

- `{{MediaPath}}` (لوکل عارضی فائل پاتھ)
- `{{MediaUrl}}` (پسودو-URL)
- `{{Transcript}}` (اگر آڈیو ٹرانسکرپشن فعال ہو)

Set `agents.defaults.heartbeat.every: "0m"` to disable. مثال:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw انہیں نکالتا ہے اور متن کے ساتھ میڈیا کے طور پر بھیج دیتا ہے۔

## آپریشنز چیک لسٹ

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

لاگز `/tmp/openclaw/` کے تحت ہوتے ہیں (بطورِ طے شدہ: `openclaw-YYYY-MM-DD.log`)۔

## اگلے اقدامات

- WebChat: [WebChat](/web/webchat)
- Gateway ops: [Gateway runbook](/gateway)
- Cron + wakeups: [Cron jobs](/automation/cron-jobs)
- macOS مینو بار کمپینین: [OpenClaw macOS app](/platforms/macos)
- iOS نوڈ ایپ: [iOS app](/platforms/ios)
- Android نوڈ ایپ: [Android app](/platforms/android)
- Windows اسٹیٹس: [Windows (WSL2)](/platforms/windows)
- Linux اسٹیٹس: [Linux app](/platforms/linux)
- سکیورٹی: [Security](/gateway/security)
