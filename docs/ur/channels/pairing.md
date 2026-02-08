---
summary: "جوڑی بنانے کا جائزہ: کس کو آپ کو DM کرنے کی اجازت ہے + کون سے نوڈز شامل ہو سکتے ہیں"
read_when:
  - DM رسائی کنٹرول سیٹ اپ کرنا
  - نئے iOS/Android نوڈ کو جوڑنا
  - OpenClaw کی سکیورٹی پوزیشن کا جائزہ لینا
title: "جوڑی بنانا"
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:59Z
---

# جوڑی بنانا

“جوڑی بنانا” OpenClaw میں **مالک کی واضح منظوری** کا مرحلہ ہے۔
یہ دو جگہوں پر استعمال ہوتا ہے:

1. **DM جوڑی بنانا** (کون بوٹ سے بات کر سکتا ہے)
2. **نوڈ جوڑی بنانا** (کون سے ڈیوائسز/نوڈز گیٹ وے نیٹ ورک میں شامل ہو سکتے ہیں)

سکیورٹی سیاق: [Security](/gateway/security)

## 1) DM جوڑی بنانا (ان باؤنڈ چیٹ رسائی)

جب کسی چینل کو DM پالیسی `pairing` کے ساتھ کنفیگر کیا جاتا ہے، تو نامعلوم ارسال کنندگان کو ایک مختصر کوڈ ملتا ہے اور آپ کی منظوری تک ان کا پیغام **پروسیس نہیں** کیا جاتا۔

ڈیفالٹ DM پالیسیاں یہاں دستاویزی ہیں: [Security](/gateway/security)

جوڑی بنانے کے کوڈز:

- 8 حروف، بڑے حروف میں، بغیر مبہم حروف (`0O1I`)۔
- **1 گھنٹے بعد میعاد ختم**۔ بوٹ جوڑی بنانے کا پیغام صرف اسی وقت بھیجتا ہے جب نئی درخواست بنے (تقریباً فی ارسال کنندہ فی گھنٹہ ایک بار)۔
- زیرِ التوا DM جوڑی بنانے کی درخواستیں بطورِ طے شدہ **ہر چینل پر 3** تک محدود ہیں؛ اضافی درخواستیں اس وقت تک نظرانداز کی جاتی ہیں جب تک کوئی ایک میعاد ختم نہ ہو یا منظور نہ ہو جائے۔

### کسی ارسال کنندہ کی منظوری

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

معاون چینلز: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`۔

### اسٹیٹ کہاں محفوظ ہوتی ہے

`~/.openclaw/credentials/` کے تحت محفوظ:

- زیرِ التوا درخواستیں: `<channel>-pairing.json`
- منظور شدہ اجازت فہرست اسٹور: `<channel>-allowFrom.json`

انہیں حساس سمجھیں (یہ آپ کے اسسٹنٹ تک رسائی کو کنٹرول کرتے ہیں)۔

## 2) نوڈ ڈیوائس جوڑی بنانا (iOS/Android/macOS/ہیڈلیس نوڈز)

نوڈز گیٹ وے سے **ڈیوائسز** کے طور پر `role: node` کے ساتھ جڑتے ہیں۔ گیٹ وے
ایک ڈیوائس جوڑی بنانے کی درخواست بناتا ہے جسے منظور کرنا لازم ہے۔

### نوڈ ڈیوائس کی منظوری

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### نوڈ جوڑی بنانے کی اسٹیٹ کا ذخیرہ

`~/.openclaw/devices/` کے تحت محفوظ:

- `pending.json` (مختصر مدت؛ زیرِ التوا درخواستیں میعاد ختم ہو جاتی ہیں)
- `paired.json` (جوڑی بنے ہوئے ڈیوائسز + ٹوکنز)

### نوٹس

- لیگیسی `node.pair.*` API (CLI: `openclaw nodes pending/approve`) ایک
  علیحدہ گیٹ وے-ملکیت والا جوڑی بنانے کا اسٹور ہے۔ WS نوڈز کو اب بھی ڈیوائس جوڑی بنانے کی ضرورت ہوتی ہے۔

## متعلقہ دستاویزات

- سکیورٹی ماڈل + پرامپٹ انجیکشن: [Security](/gateway/security)
- محفوظ طریقے سے اپڈیٹ کرنا (رن ڈاکٹر): [Updating](/install/updating)
- چینل کنفیگز:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (لیگیسی): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
