---
summary: "‏~/.openclaw/openclaw.json کے لیے تمام کنفیگریشن اختیارات مثالوں کے ساتھ"
read_when:
  - کنفیگ فیلڈز شامل کرتے یا ترمیم کرتے وقت
title: "کنفیگریشن"
x-i18n:
  source_path: gateway/configuration.md
  source_hash: e226e24422c05e7e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:28Z
---

# کنفیگریشن 🔧

OpenClaw ایک اختیاری **JSON5** کنفیگ `~/.openclaw/openclaw.json` سے پڑھتا ہے (تبصرے + آخر میں کاما کی اجازت ہے)۔

اگر فائل موجود نہ ہو تو OpenClaw نسبتاً محفوظ ڈیفالٹس استعمال کرتا ہے (ایمبیڈڈ Pi ایجنٹ + ہر ارسال کنندہ کے لیے سیشنز + ورک اسپیس `~/.openclaw/workspace`)۔ عموماً آپ کو کنفیگ کی ضرورت صرف اس وقت پڑتی ہے جب آپ:

- اس بات کو محدود کرنا چاہیں کہ بوٹ کو کون ٹرگر کر سکتا ہے (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom` وغیرہ)
- گروپ اجازت فہرستیں اور منشن رویہ کنٹرول کریں (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- پیغام کے سابقے حسبِ ضرورت بنائیں (`messages`)
- ایجنٹ کا ورک اسپیس سیٹ کریں (`agents.defaults.workspace` یا `agents.list[].workspace`)
- ایمبیڈڈ ایجنٹ کے ڈیفالٹس (`agents.defaults`) اور سیشن رویے (`session`) کو ٹیون کریں
- ہر ایجنٹ کی شناخت سیٹ کریں (`agents.list[].identity`)

> **کنفیگریشن میں نئے ہیں؟** مکمل مثالوں اور تفصیلی وضاحتوں کے لیے [Configuration Examples](/gateway/configuration-examples) گائیڈ دیکھیں!

## سخت کنفیگ کی توثیق

OpenClaw صرف وہ کنفیگریشنز قبول کرتا ہے جو مکمل طور پر اسکیما سے مطابقت رکھتی ہوں۔
نامعلوم کلیدیں، خراب اقسام، یا غلط اقدار سکیورٹی کے لیے Gateway کو **شروع ہونے سے روک دیتی ہیں**۔

جب توثیق ناکام ہو:

- Gateway بوٹ نہیں ہوتا۔
- صرف تشخیصی کمانڈز کی اجازت ہوتی ہے (مثلاً: `openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`)۔
- درست مسائل دیکھنے کے لیے `openclaw doctor` چلائیں۔
- مائیگریشن/مرمت لاگو کرنے کے لیے `openclaw doctor --fix` (یا `--yes`) چلائیں۔

Doctor کبھی تبدیلیاں نہیں لکھتا جب تک آپ واضح طور پر `--fix`/`--yes` میں شامل نہ ہوں۔

## اسکیما + UI اشارے

Gateway کنفیگ کی JSON Schema نمائندگی `config.schema` کے ذریعے UI ایڈیٹرز کے لیے فراہم کرتا ہے۔
کنٹرول UI اس اسکیما سے ایک فارم رینڈر کرتا ہے، اور بطورِ متبادل **Raw JSON** ایڈیٹر بھی فراہم کرتا ہے۔

چینل پلگ اِنز اور ایکسٹینشنز اپنی کنفیگ کے لیے اسکیما + UI اشارے رجسٹر کر سکتے ہیں، تاکہ
چینل سیٹنگز مختلف ایپس میں بغیر ہارڈ کوڈڈ فارمز کے اسکیما پر مبنی رہیں۔

اشارے (لیبلز، گروپنگ، حساس فیلڈز) اسکیما کے ساتھ فراہم کیے جاتے ہیں تاکہ کلائنٹس
بغیر کنفیگ علم ہارڈ کوڈ کیے بہتر فارمز رینڈر کر سکیں۔

## لاگو کریں + ری اسٹارٹ (RPC)

`config.apply` استعمال کریں تاکہ ایک ہی قدم میں مکمل کنفیگ کی توثیق، تحریر اور Gateway ری اسٹارٹ ہو جائے۔
یہ ری اسٹارٹ سینٹینل لکھتا ہے اور Gateway کے واپس آنے کے بعد آخری فعال سیشن کو پِنگ کرتا ہے۔

خبردار: `config.apply` **پوری کنفیگ** کو بدل دیتا ہے۔ اگر آپ صرف چند کلیدیں بدلنا چاہتے ہیں،
تو `config.patch` یا `openclaw config set` استعمال کریں۔ `~/.openclaw/openclaw.json` کا بیک اپ رکھیں۔

Params:

- `raw` (string) — پوری کنفیگ کے لیے JSON5 پے لوڈ
- `baseHash` (اختیاری) — `config.get` سے کنفیگ ہیش (جب کنفیگ پہلے سے موجود ہو تو لازم)
- `sessionKey` (اختیاری) — ویک اپ پِنگ کے لیے آخری فعال سیشن کلید
- `note` (اختیاری) — ری اسٹارٹ سینٹینل میں شامل کرنے کے لیے نوٹ
- `restartDelayMs` (اختیاری) — ری اسٹارٹ سے پہلے تاخیر (ڈیفالٹ 2000)

مثال (`gateway call` کے ذریعے):

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## جزوی اپ ڈیٹس (RPC)

`config.patch` استعمال کریں تاکہ موجودہ کنفیگ میں جزوی اپ ڈیٹ ضم کی جا سکے بغیر
غیر متعلقہ کلیدوں کو متاثر کیے۔ یہ JSON merge patch semantics لاگو کرتا ہے:

- آبجیکٹس ریکرسیولی ضم ہوتے ہیں
- `null` کسی کلید کو حذف کرتا ہے
- arrays مکمل طور پر بدل دیے جاتے ہیں  
  `config.apply` کی طرح، یہ توثیق کرتا ہے، کنفیگ لکھتا ہے، ری اسٹارٹ سینٹینل محفوظ کرتا ہے، اور
  Gateway ری اسٹارٹ شیڈول کرتا ہے (جب `sessionKey` فراہم ہو تو اختیاری ویک کے ساتھ)۔

Params:

- `raw` (string) — صرف تبدیل ہونے والی کلیدوں پر مشتمل JSON5 پے لوڈ
- `baseHash` (لازم) — `config.get` سے کنفیگ ہیش
- `sessionKey` (اختیاری) — ویک اپ پِنگ کے لیے آخری فعال سیشن کلید
- `note` (اختیاری) — ری اسٹارٹ سینٹینل میں شامل کرنے کے لیے نوٹ
- `restartDelayMs` (اختیاری) — ری اسٹارٹ سے پہلے تاخیر (ڈیفالٹ 2000)

مثال:

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## کم از کم کنفیگ (سفارش کردہ ابتدائی نقطہ)

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

ڈیفالٹ امیج ایک بار اس طرح بنائیں:

```bash
scripts/sandbox-setup.sh
```

## سیلف-چیٹ موڈ (گروپ کنٹرول کے لیے سفارش کردہ)

WhatsApp گروپس میں @-منشنز پر بوٹ کے جواب کو روکنے کے لیے (صرف مخصوص متنی ٹرگرز پر جواب):

```json5
{
  agents: {
    defaults: { workspace: "~/.openclaw/workspace" },
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["@openclaw", "reisponde"] },
      },
    ],
  },
  channels: {
    whatsapp: {
      // Allowlist is DMs only; including your own number enables self-chat mode.
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## کنفیگ Includes (`$include`)

`$include` ڈائریکٹو استعمال کرتے ہوئے اپنی کنفیگ کو متعدد فائلوں میں تقسیم کریں۔ یہ مفید ہے:

- بڑی کنفیگز کو منظم کرنے کے لیے (مثلاً ہر کلائنٹ کے لیے ایجنٹ تعریفیں)
- مختلف ماحولوں میں مشترکہ سیٹنگز شیئر کرنے کے لیے
- حساس کنفیگز کو الگ رکھنے کے لیے

### بنیادی استعمال

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },

  // Include a single file (replaces the key's value)
  agents: { $include: "./agents.json5" },

  // Include multiple files (deep-merged in order)
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

```json5
// ~/.openclaw/agents.json5
{
  defaults: { sandbox: { mode: "all", scope: "session" } },
  list: [{ id: "main", workspace: "~/.openclaw/workspace" }],
}
```

### مرج رویہ

- **ایک فائل**: `$include` رکھنے والے آبجیکٹ کو بدل دیتی ہے
- **فائلوں کی array**: ترتیب کے مطابق ڈیپ مرج (بعد والی فائلیں پہلے والیوں کو اوور رائیڈ کرتی ہیں)
- **ہمسایہ کلیدوں کے ساتھ**: includes کے بعد ہمسایہ کلیدیں مرج ہوتی ہیں (شامل شدہ اقدار کو اوور رائیڈ کرتی ہیں)
- **ہمسایہ کلیدیں + arrays/primitives**: سپورٹڈ نہیں (شامل شدہ مواد لازماً آبجیکٹ ہونا چاہیے)

```json5
// Sibling keys override included values
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // Result: { a: 1, b: 99 }
}
```

### نیسٹڈ includes

شامل شدہ فائلیں خود بھی `$include` ڈائریکٹوز رکھ سکتی ہیں (زیادہ سے زیادہ 10 سطحیں):

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### راستے کی ریزولوشن

- **نسبتی راستے**: شامل کرنے والی فائل کے نسبت سے حل ہوتے ہیں
- **مطلق راستے**: جوں کے توں استعمال ہوتے ہیں
- **پیرنٹ ڈائریکٹریز**: `../` حوالہ جات متوقع طور پر کام کرتے ہیں

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### خرابیوں کا ازالہ

- **گمشدہ فائل**: حل شدہ راستے کے ساتھ واضح خرابی
- **پارْس خرابی**: بتاتا ہے کون سی شامل شدہ فائل ناکام ہوئی
- **سرکولر includes**: include چین کے ساتھ شناخت اور رپورٹ

### مثال: ملٹی کلائنٹ قانونی سیٹ اپ

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789, auth: { token: "secret" } },

  // Common agent defaults
  agents: {
    defaults: {
      sandbox: { mode: "all", scope: "session" },
    },
    // Merge agent lists from all clients
    list: { $include: ["./clients/mueller/agents.json5", "./clients/schmidt/agents.json5"] },
  },

  // Merge broadcast configs
  broadcast: {
    $include: ["./clients/mueller/broadcast.json5", "./clients/schmidt/broadcast.json5"],
  },

  channels: { whatsapp: { groupPolicy: "allowlist" } },
}
```

```json5
// ~/.openclaw/clients/mueller/agents.json5
[
  { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
  { id: "mueller-docs", workspace: "~/clients/mueller/docs" },
]
```

```json5
// ~/.openclaw/clients/mueller/broadcast.json5
{
  "120363403215116621@g.us": ["mueller-transcribe", "mueller-docs"],
}
```

_(اگلا: [Agent Runtime](/concepts/agent))_ 🦞
