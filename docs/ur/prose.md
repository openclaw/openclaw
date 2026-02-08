---
summary: "OpenProse: OpenClaw میں .prose ورک فلو، سلیش کمانڈز، اور اسٹیٹ"
read_when:
  - آپ .prose ورک فلو چلانا یا لکھنا چاہتے ہوں
  - آپ OpenProse پلگ اِن فعال کرنا چاہتے ہوں
  - آپ کو اسٹیٹ اسٹوریج کو سمجھنے کی ضرورت ہو
title: "OpenProse"
x-i18n:
  source_path: prose.md
  source_hash: 53c161466d278e5f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:37Z
---

# OpenProse

OpenProse ایک قابلِ منتقلی، مارک ڈاؤن فرسٹ ورک فلو فارمیٹ ہے جو AI سیشنز کی ترتیب و تنظیم کے لیے استعمال ہوتا ہے۔ OpenClaw میں یہ ایک پلگ اِن کے طور پر آتا ہے جو OpenProse Skills پیک کے ساتھ ایک `/prose` سلیش کمانڈ انسٹال کرتا ہے۔ پروگرامز `.prose` فائلوں میں رہتے ہیں اور واضح کنٹرول فلو کے ساتھ متعدد ذیلی ایجنٹس تخلیق کر سکتے ہیں۔

سرکاری ویب سائٹ: [https://www.prose.md](https://www.prose.md)

## یہ کیا کر سکتا ہے

- واضح متوازی عمل کے ساتھ کثیر ایجنٹ تحقیق اور ترکیب۔
- دہرائے جانے کے قابل، منظوری سے محفوظ ورک فلو (کوڈ ریویو، انسیڈنٹ ٹرائج، مواد پائپ لائنز)۔
- قابلِ دوبارہ استعمال `.prose` پروگرامز جنہیں آپ معاون ایجنٹ رن ٹائمز میں چلا سکتے ہیں۔

## انسٹال کریں + فعال کریں

بنڈل شدہ پلگ اِنز بطورِ طے شدہ غیرفعال ہوتے ہیں۔ OpenProse کو فعال کریں:

```bash
openclaw plugins enable open-prose
```

پلگ اِن فعال کرنے کے بعد Gateway کو ری اسٹارٹ کریں۔

ڈیولپر/لوکل چیک آؤٹ: `openclaw plugins install ./extensions/open-prose`

متعلقہ دستاویزات: [Plugins](/tools/plugin)، [Plugin manifest](/plugins/manifest)، [Skills](/tools/skills)۔

## سلیش کمانڈ

OpenProse ایک صارف کے ذریعے قابلِ استعمال Skills کمانڈ کے طور پر `/prose` رجسٹر کرتا ہے۔ یہ OpenProse VM ہدایات کی طرف روٹ کرتا ہے اور پسِ پردہ OpenClaw کے اوزار استعمال کرتا ہے۔

عام کمانڈز:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## مثال: ایک سادہ `.prose` فائل

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## فائل کی جگہیں

OpenProse آپ کے ورک اسپیس میں `.prose/` کے تحت اسٹیٹ رکھتا ہے:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

صارف سطح کے مستقل ایجنٹس یہاں ہوتے ہیں:

```
~/.prose/agents/
```

## اسٹیٹ موڈز

OpenProse متعدد اسٹیٹ بیک اینڈز کی حمایت کرتا ہے:

- **filesystem** (بطورِ طے شدہ): `.prose/runs/...`
- **in-context**: عارضی، چھوٹے پروگرامز کے لیے
- **sqlite** (تجرباتی): `sqlite3` بائنری درکار
- **postgres** (تجرباتی): `psql` اور کنکشن اسٹرنگ درکار

نوٹس:

- sqlite/postgres اختیاری اور تجرباتی ہیں۔
- postgres اسناد ذیلی ایجنٹ لاگز میں شامل ہو جاتی ہیں؛ ایک مخصوص، کم سے کم اختیارات والا DB استعمال کریں۔

## ریموٹ پروگرامز

`/prose run <handle/slug>`، `https://p.prose.md/<handle>/<slug>` میں ریزولو ہو جاتا ہے۔
براہِ راست URLs جیسے ہیں ویسے ہی فیچ کیے جاتے ہیں۔ اس میں `web_fetch` ٹول استعمال ہوتا ہے (یا POST کے لیے `exec`)۔

## OpenClaw رن ٹائم میپنگ

OpenProse پروگرامز OpenClaw کے بنیادی اجزاء سے میپ ہوتے ہیں:

| OpenProse تصور        | OpenClaw ٹول     |
| --------------------- | ---------------- |
| سیشن اسپان / Task ٹول | `sessions_spawn` |
| فائل پڑھنا/لکھنا      | `read` / `write` |
| ویب فیچ               | `web_fetch`      |

اگر آپ کی ٹول اجازت فہرست ان ٹولز کو بلاک کرتی ہے تو OpenProse پروگرامز ناکام ہو جائیں گے۔ [Skills config](/tools/skills-config) دیکھیں۔

## سکیورٹی + منظوریات

`.prose` فائلوں کو کوڈ کی طرح سمجھیں۔ چلانے سے پہلے ریویو کریں۔ سائیڈ ایفیکٹس کو کنٹرول کرنے کے لیے OpenClaw ٹول اجازت فہرستیں اور منظوری گیٹس استعمال کریں۔

متعین، منظوری سے بندھے ورک فلو کے لیے [Lobster](/tools/lobster) سے موازنہ کریں۔
