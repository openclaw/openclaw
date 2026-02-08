---
summary: "ڈیبگنگ ٹولز: واچ موڈ، خام ماڈل اسٹریمز، اور استدلال کے اخراج کی ٹریسنگ"
read_when:
  - آپ کو استدلال کے اخراج کے لیے خام ماڈل آؤٹ پٹ کا معائنہ کرنا ہو
  - آپ تکرار کے دوران Gateway کو واچ موڈ میں چلانا چاہتے ہوں
  - آپ کو ایک قابلِ تکرار ڈیبگنگ ورک فلو درکار ہو
title: "ڈیبگنگ"
x-i18n:
  source_path: help/debugging.md
  source_hash: 504c824bff479000
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:24Z
---

# ڈیبگنگ

یہ صفحہ اسٹریمنگ آؤٹ پٹ کے لیے ڈیبگنگ معاونات کا احاطہ کرتا ہے، خاص طور پر اس صورت میں جب کوئی فراہم کنندہ عام متن میں استدلال کو ملا دے۔

## رن ٹائم ڈیبگ اووررائیڈز

چیٹ میں **`/debug`** استعمال کریں تاکہ **صرف رن ٹائم** کنفیگ اووررائیڈز (میموری میں، ڈسک پر نہیں) سیٹ کیے جا سکیں۔
**`/debug`** بطورِ طے شدہ غیرفعال ہے؛ اسے **`commands.debug: true`** کے ساتھ فعال کریں۔
یہ اس وقت مفید ہوتا ہے جب آپ کو **`openclaw.json`** میں ترمیم کیے بغیر غیر معروف سیٹنگز کو ٹوگل کرنا ہو۔

مثالیں:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

**`/debug reset`** تمام اووررائیڈز صاف کر دیتا ہے اور آن-ڈسک کنفیگ پر واپس آ جاتا ہے۔

## Gateway واچ موڈ

تیز تکرار کے لیے، گیٹ وے کو فائل واچر کے تحت چلائیں:

```bash
pnpm gateway:watch --force
```

یہ اس کے مساوی ہے:

```bash
tsx watch src/entry.ts gateway --force
```

**`gateway:watch`** کے بعد کوئی بھی gateway CLI فلیگز شامل کریں، اور وہ ہر ری اسٹارٹ پر پاس تھرو ہو جائیں گے۔

## ڈیو پروفائل + ڈیو گیٹ وے (--dev)

ڈیبگنگ کے لیے اسٹیٹ کو الگ رکھنے اور ایک محفوظ، قابلِ تلف سیٹ اپ شروع کرنے کے لیے ڈیو پروفائل استعمال کریں۔ **دو** **`--dev`** فلیگز ہیں:

- **عالمی `--dev` (پروفائل):** اسٹیٹ کو **`~/.openclaw-dev`** کے تحت الگ کرتا ہے اور
  گیٹ وے پورٹ کو بطورِ طے شدہ **`19001`** پر سیٹ کرتا ہے (اس کے ساتھ اخذ شدہ پورٹس بھی تبدیل ہوتی ہیں)۔
- **`gateway --dev`: Gateway کو ہدایت دیتا ہے کہ کمی کی صورت میں ڈیفالٹ کنفیگ +
  ورک اسپیس خودکار طور پر بنائے** (اور BOOTSTRAP.md کو اسکیپ کرے)۔

سفارش کردہ فلو (ڈیو پروفائل + ڈیو بوٹسٹرَیپ):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

اگر ابھی تک آپ کے پاس گلوبل انسٹال موجود نہیں ہے تو CLI کو **`pnpm openclaw ...`** کے ذریعے چلائیں۔

یہ کیا کرتا ہے:

1. **پروفائل آئسولیشن** (عالمی **`--dev`**)
   - **`OPENCLAW_PROFILE=dev`**
   - **`OPENCLAW_STATE_DIR=~/.openclaw-dev`**
   - **`OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`**
   - **`OPENCLAW_GATEWAY_PORT=19001`** (براؤزر/کینوس اسی کے مطابق شفٹ ہوتے ہیں)

2. **ڈیو بوٹسٹرَیپ** (**`gateway --dev`**)
   - اگر موجود نہ ہو تو ایک کم سے کم کنفیگ لکھتا ہے (**`gateway.mode=local`**، bind loopback)۔
   - **`agent.workspace`** کو ڈیو ورک اسپیس پر سیٹ کرتا ہے۔
   - **`agent.skipBootstrap=true`** سیٹ کرتا ہے (BOOTSRTAP.md نہیں)۔
   - اگر موجود نہ ہوں تو ورک اسپیس فائلز سیڈ کرتا ہے:
     **`AGENTS.md`**, **`SOUL.md`**, **`TOOLS.md`**, **`IDENTITY.md`**, **`USER.md`**, **`HEARTBEAT.md`**۔
   - ڈیفالٹ شناخت: **C3‑PO** (پروٹوکول ڈرائیڈ)۔
   - ڈیو موڈ میں چینل فراہم کنندگان کو اسکیپ کرتا ہے (**`OPENCLAW_SKIP_CHANNELS=1`**)۔

ری سیٹ فلو (نئی شروعات):

```bash
pnpm gateway:dev:reset
```

نوٹ: **`--dev`** ایک **عالمی** پروفائل فلیگ ہے اور کچھ رنرز اسے نگل لیتے ہیں۔
اگر آپ کو اسے واضح طور پر لکھنا ہو تو env var فارم استعمال کریں:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

**`--reset`** کنفیگ، اسناد، سیشنز، اور ڈیو ورک اسپیس کو صاف کر دیتا ہے (استعمال کرتے ہوئے
**`trash`**، نہ کہ **`rm`**)، پھر ڈیفالٹ ڈیو سیٹ اپ دوبارہ بناتا ہے۔

مشورہ: اگر کوئی نان‑ڈیو گیٹ وے پہلے سے چل رہا ہو (launchd/systemd)، تو پہلے اسے بند کریں:

```bash
openclaw gateway stop
```

## خام اسٹریم لاگنگ (OpenClaw)

OpenClaw کسی بھی فلٹرنگ/فارمیٹنگ سے پہلے **خام اسسٹنٹ اسٹریم** کو لاگ کر سکتا ہے۔
یہ دیکھنے کا بہترین طریقہ ہے کہ آیا استدلال سادہ متن ڈیلٹاز کے طور پر آ رہا ہے
(یا الگ thinking بلاکس کی صورت میں)۔

CLI کے ذریعے فعال کریں:

```bash
pnpm gateway:watch --force --raw-stream
```

اختیاری پاتھ اووررائیڈ:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

مساوی env vars:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

ڈیفالٹ فائل:

`~/.openclaw/logs/raw-stream.jsonl`

## خام چنک لاگنگ (pi-mono)

بلاکس میں پارس ہونے سے پہلے **خام OpenAI-مطابقت رکھنے والے چنکس** کو کیپچر کرنے کے لیے،
pi-mono ایک علیحدہ لاگر فراہم کرتا ہے:

```bash
PI_RAW_STREAM=1
```

اختیاری پاتھ:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

ڈیفالٹ فائل:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> نوٹ: یہ صرف ان پروسیسز کے ذریعے خارج ہوتا ہے جو pi-mono کے
> **`openai-completions`** فراہم کنندہ کو استعمال کرتے ہیں۔

## سکیورٹی نوٹس

- خام اسٹریم لاگز میں مکمل پرامپٹس، ٹول آؤٹ پٹ، اور صارف ڈیٹا شامل ہو سکتا ہے۔
- لاگز کو مقامی رکھیں اور ڈیبگنگ کے بعد حذف کر دیں۔
- اگر آپ لاگز شیئر کریں تو پہلے راز اور PII صاف کریں۔
