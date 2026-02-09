---
summary: "Mattermost بوٹ سیٹ اپ اور OpenClaw کنفیگ"
read_when:
  - Mattermost سیٹ اپ کرنا
  - Mattermost روٹنگ کی خرابیوں کا ازالہ
title: "Mattermost"
---

# Mattermost (پلگ اِن)

اسٹیٹس: پلگ اِن کے ذریعے سپورٹ شدہ (بوٹ ٹوکن + WebSocket ایونٹس)۔ چینلز، گروپس، اور DMs سپورٹڈ ہیں۔
Mattermost ایک خود ہوسٹ ہونے والا ٹیم میسجنگ پلیٹ فارم ہے؛ پروڈکٹ کی تفصیلات اور ڈاؤن لوڈز کے لیے آفیشل سائٹ دیکھیں:
[mattermost.com](https://mattermost.com)۔

## پلگ اِن درکار ہے

Mattermost بطور پلگ اِن فراہم کیا جاتا ہے اور کور انسٹال کے ساتھ شامل نہیں ہوتا۔

CLI کے ذریعے انسٹال کریں (npm رجسٹری):

```bash
openclaw plugins install @openclaw/mattermost
```

لوکل چیک آؤٹ (جب git ریپو سے چلایا جا رہا ہو):

```bash
openclaw plugins install ./extensions/mattermost
```

اگر آپ configure/onboarding کے دوران Mattermost منتخب کریں اور git چیک آؤٹ موجود ہو،
تو OpenClaw خودکار طور پر لوکل انسٹال کا راستہ پیش کرے گا۔

تفصیلات: [Plugins](/tools/plugin)

## فوری سیٹ اپ

1. Mattermost پلگ اِن انسٹال کریں۔
2. Mattermost بوٹ اکاؤنٹ بنائیں اور **بوٹ ٹوکن** کاپی کریں۔
3. Mattermost **بیس URL** کاپی کریں (مثلاً، `https://chat.example.com`)۔
4. OpenClaw کنفیگر کریں اور Gateway شروع کریں۔

کم از کم کنفیگ:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## ماحولیاتی متغیرات (ڈیفالٹ اکاؤنٹ)

اگر آپ env vars کو ترجیح دیتے ہیں تو انہیں گیٹ وے ہوسٹ پر سیٹ کریں:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Env ویری ایبلز صرف **ڈیفالٹ** اکاؤنٹ (`default`) پر لاگو ہوتے ہیں۔ دیگر اکاؤنٹس کو کنفیگ ویلیوز استعمال کرنا ہوں گی۔

## چیٹ موڈز

Mattermost خودکار طور پر DMs کا جواب دیتا ہے۔ چینل کا رویہ `chatmode` کے ذریعے کنٹرول ہوتا ہے:

- `oncall` (بطورِ طے شدہ): چینلز میں صرف @ذکر کیے جانے پر جواب دیں۔
- `onmessage`: ہر چینل پیغام پر جواب دیں۔
- `onchar`: جب پیغام ٹرگر پری فکس سے شروع ہو تو جواب دیں۔

کنفیگ کی مثال:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

نوٹس:

- `onchar` واضح @ذکر پر پھر بھی جواب دیتا ہے۔
- `channels.mattermost.requireMention` لیگیسی کنفیگز کے لیے قابلِ قبول ہے لیکن `chatmode` کو ترجیح دی جاتی ہے۔

## رسائی کا کنٹرول (DMs)

- ڈیفالٹ: `channels.mattermost.dmPolicy = "pairing"` (نامعلوم ارسال کنندگان کو pairing کوڈ ملتا ہے)۔
- منظوری بذریعہ:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- عوامی DMs: `channels.mattermost.dmPolicy="open"` کے ساتھ `channels.mattermost.allowFrom=["*"]`۔

## چینلز (گروپس)

- ڈیفالٹ: `channels.mattermost.groupPolicy = "allowlist"` (mention-gated)۔
- اجازت فہرست کے ذریعے ارسال کنندگان کی اجازت دیں: `channels.mattermost.groupAllowFrom` (صارف IDs یا `@username`)۔
- کھلے چینلز: `channels.mattermost.groupPolicy="open"` (mention-gated)۔

## آؤٹ باؤنڈ ترسیل کے اہداف

`openclaw message send` یا cron/webhooks کے ساتھ یہ ہدف فارمیٹس استعمال کریں:

- چینل کے لیے `channel:<id>`
- DM کے لیے `user:<id>`
- DM کے لیے `@username` (Mattermost API کے ذریعے حل کیا جاتا ہے)

سادہ IDs کو چینلز سمجھا جاتا ہے۔

## ملٹی اکاؤنٹ

Mattermost، `channels.mattermost.accounts` کے تحت متعدد اکاؤنٹس کی معاونت کرتا ہے:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## خرابیوں کا ازالہ

- چینلز میں جواب نہیں آ رہا: یقینی بنائیں کہ بوٹ چینل میں موجود ہے اور اسے mention کریں (oncall)، ٹرگر پری فکس استعمال کریں (onchar)، یا `chatmode: "onmessage"` سیٹ کریں۔
- تصدیقی غلطیاں: بوٹ ٹوکن، بیس URL، اور یہ کہ اکاؤنٹ فعال ہے یا نہیں، چیک کریں۔
- ملٹی اکاؤنٹ مسائل: env vars صرف `default` اکاؤنٹ پر لاگو ہوتے ہیں۔
