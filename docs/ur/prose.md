---
summary: "OpenProse: OpenClaw میں .prose ورک فلو، سلیش کمانڈز، اور اسٹیٹ"
read_when:
  - آپ .prose ورک فلو چلانا یا لکھنا چاہتے ہوں
  - آپ OpenProse پلگ اِن فعال کرنا چاہتے ہوں
  - آپ کو اسٹیٹ اسٹوریج کو سمجھنے کی ضرورت ہو
title: "OpenProse"
---

# OpenProse

OpenProse ایک قابلِ نقل، مارک ڈاؤن پر مبنی ورک فلو فارمیٹ ہے جو AI سیشنز کو منظم کرنے کے لیے استعمال ہوتا ہے۔ OpenClaw میں یہ ایک پلگ اِن کے طور پر آتا ہے جو OpenProse اسکل پیک کے ساتھ ایک `/prose` سلیش کمانڈ انسٹال کرتا ہے۔ پروگرامز `.prose` فائلوں میں ہوتے ہیں اور واضح کنٹرول فلو کے ساتھ متعدد ذیلی ایجنٹس بنا سکتے ہیں۔

سرکاری ویب سائٹ: [https://www.prose.md](https://www.prose.md)

## یہ کیا کر سکتا ہے

- واضح متوازی عمل کے ساتھ کثیر ایجنٹ تحقیق اور ترکیب۔
- دہرائے جانے کے قابل، منظوری سے محفوظ ورک فلو (کوڈ ریویو، انسیڈنٹ ٹرائج، مواد پائپ لائنز)۔
- قابلِ دوبارہ استعمال `.prose` پروگرامز جنہیں آپ معاون ایجنٹ رن ٹائمز میں چلا سکتے ہیں۔

## انسٹال کریں + فعال کریں

بنڈل شدہ پلگ اِنز بطورِ ڈیفالٹ غیر فعال ہوتے ہیں۔ Enable OpenProse:

```bash
openclaw plugins enable open-prose
```

پلگ اِن فعال کرنے کے بعد Gateway کو ری اسٹارٹ کریں۔

ڈیولپر/لوکل چیک آؤٹ: `openclaw plugins install ./extensions/open-prose`

متعلقہ دستاویزات: [Plugins](/tools/plugin)، [Plugin manifest](/plugins/manifest)، [Skills](/tools/skills)۔

## سلیش کمانڈ

OpenProse `/prose` کو صارف کے ذریعے چلائی جانے والی اسکل کمانڈ کے طور پر رجسٹر کرتا ہے۔ یہ OpenProse VM ہدایات کی طرف روٹ کرتا ہے اور پس منظر میں OpenClaw ٹولز استعمال کرتا ہے۔

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

`/prose run <handle/slug>` حل ہو کر `https://p.prose.md/<handle>/<slug>` بنتا ہے۔
براہِ راست URLs کو جوں کا توں حاصل کیا جاتا ہے۔ یہ `web_fetch` ٹول استعمال کرتا ہے (یا POST کے لیے `exec`)۔

## OpenClaw رن ٹائم میپنگ

OpenProse پروگرامز OpenClaw کے بنیادی اجزاء سے میپ ہوتے ہیں:

| OpenProse تصور        | OpenClaw ٹول     |
| --------------------- | ---------------- |
| سیشن اسپان / Task ٹول | `sessions_spawn` |
| فائل پڑھنا/لکھنا      | `read` / `write` |
| ویب فیچ               | `web_fetch`      |

اگر آپ کی ٹول allowlist ان ٹولز کو بلاک کرتی ہے تو OpenProse پروگرام ناکام ہو جائیں گے۔ [Skills config](/tools/skills-config) دیکھیں۔

## سکیورٹی + منظوریات

`.prose` فائلوں کو کوڈ کی طرح سمجھیں۔ چلانے سے پہلے جائزہ لیں۔ ضمنی اثرات کو کنٹرول کرنے کے لیے OpenClaw ٹول allowlists اور منظوری کے مراحل استعمال کریں۔

متعین، منظوری سے بندھے ورک فلو کے لیے [Lobster](/tools/lobster) سے موازنہ کریں۔
