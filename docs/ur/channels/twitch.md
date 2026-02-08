---
summary: "Twitch چیٹ بوٹ کی کنفیگریشن اور سیٹ اپ"
read_when:
  - OpenClaw کے لیے Twitch چیٹ انٹیگریشن سیٹ اپ کرتے وقت
title: "Twitch"
x-i18n:
  source_path: channels/twitch.md
  source_hash: 4fa7daa11d1e5ed4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:13Z
---

# Twitch (پلگ ان)

IRC کنکشن کے ذریعے Twitch چیٹ سپورٹ۔ OpenClaw ایک Twitch صارف (بوٹ اکاؤنٹ) کے طور پر کنیکٹ ہوتا ہے تاکہ چینلز میں پیغامات وصول اور ارسال کر سکے۔

## مطلوبہ پلگ ان

Twitch ایک پلگ ان کے طور پر فراہم کیا جاتا ہے اور کور انسٹال کے ساتھ شامل نہیں ہوتا۔

CLI کے ذریعے انسٹال کریں (npm رجسٹری):

```bash
openclaw plugins install @openclaw/twitch
```

لوکل چیک آؤٹ (جب git ریپو سے چلایا جا رہا ہو):

```bash
openclaw plugins install ./extensions/twitch
```

تفصیلات: [Plugins](/tools/plugin)

## فوری سیٹ اپ (مبتدی)

1. بوٹ کے لیے ایک مخصوص Twitch اکاؤنٹ بنائیں (یا موجودہ اکاؤنٹ استعمال کریں)۔
2. اسناد تیار کریں: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - **Bot Token** منتخب کریں
   - تصدیق کریں کہ اسکوپس `chat:read` اور `chat:write` منتخب ہیں
   - **Client ID** اور **Access Token** کاپی کریں
3. اپنا Twitch یوزر آئی ڈی تلاش کریں: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. ٹوکن کنفیگر کریں:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (صرف ڈیفالٹ اکاؤنٹ)
   - یا کنفیگ: `channels.twitch.accessToken`
   - اگر دونوں سیٹ ہوں تو کنفیگ کو ترجیح دی جاتی ہے (env فالبیک صرف ڈیفالٹ اکاؤنٹ کے لیے ہے)۔
5. گیٹ وے شروع کریں۔

**⚠️ اہم:** غیر مجاز صارفین کو بوٹ ٹرگر کرنے سے روکنے کے لیے رسائی کنٹرول (`allowFrom` یا `allowedRoles`) شامل کریں۔ `requireMention` بطورِ طے شدہ `true` ہے۔

کم سے کم کنفیگ:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## یہ کیا ہے

- Gateway کی ملکیت والا ایک Twitch چینل۔
- متعین روٹنگ: جوابات ہمیشہ Twitch پر واپس جاتے ہیں۔
- ہر اکاؤنٹ ایک الگ سیشن کلید `agent:<agentId>:twitch:<accountName>` سے منسلک ہوتا ہے۔
- `username` بوٹ کا اکاؤنٹ ہے (جو تصدیق کرتا ہے)، جبکہ `channel` وہ چیٹ روم ہے جس میں شامل ہونا ہے۔

## سیٹ اپ (تفصیلی)

### اسناد تیار کریں

[Twitch Token Generator](https://twitchtokengenerator.com/) استعمال کریں:

- **Bot Token** منتخب کریں
- تصدیق کریں کہ اسکوپس `chat:read` اور `chat:write` منتخب ہیں
- **Client ID** اور **Access Token** کاپی کریں

کسی دستی ایپ رجسٹریشن کی ضرورت نہیں۔ ٹوکن چند گھنٹوں بعد ختم ہو جاتے ہیں۔

### بوٹ کنفیگر کریں

**Env var (صرف ڈیفالٹ اکاؤنٹ):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**یا کنفیگ:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

اگر env اور کنفیگ دونوں سیٹ ہوں تو کنفیگ کو ترجیح دی جاتی ہے۔

### رسائی کنٹرول (سفارش کردہ)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

سخت اجازت فہرست کے لیے `allowFrom` کو ترجیح دیں۔ اگر آپ کردار پر مبنی رسائی چاہتے ہیں تو اس کے بجائے `allowedRoles` استعمال کریں۔

**دستیاب کردار:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`۔

**یوزر آئی ڈی کیوں؟** یوزرنیم تبدیل ہو سکتے ہیں، جس سے نقالی ممکن ہو جاتی ہے۔ یوزر آئی ڈیز مستقل ہوتی ہیں۔

اپنا Twitch یوزر آئی ڈی تلاش کریں: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (اپنا Twitch یوزرنیم آئی ڈی میں تبدیل کریں)

## ٹوکن ریفریش (اختیاری)

[Twitch Token Generator](https://twitchtokengenerator.com/) کے ٹوکن خودکار طور پر ریفریش نہیں ہو سکتے—مدت ختم ہونے پر دوبارہ تیار کریں۔

خودکار ٹوکن ریفریش کے لیے، [Twitch Developer Console](https://dev.twitch.tv/console) پر اپنی Twitch ایپ بنائیں اور کنفیگ میں شامل کریں:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

بوٹ مدت ختم ہونے سے پہلے خودکار طور پر ٹوکن ریفریش کرتا ہے اور ریفریش ایونٹس لاگ کرتا ہے۔

## ملٹی اکاؤنٹ سپورٹ

ہر اکاؤنٹ کے لیے الگ ٹوکنز کے ساتھ `channels.twitch.accounts` استعمال کریں۔ مشترکہ پیٹرن کے لیے [`gateway/configuration`](/gateway/configuration) دیکھیں۔

مثال (ایک بوٹ اکاؤنٹ دو چینلز میں):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**نوٹ:** ہر اکاؤنٹ کو اپنا الگ ٹوکن درکار ہے (ہر چینل کے لیے ایک ٹوکن)۔

## رسائی کنٹرول

### کردار پر مبنی پابندیاں

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### یوزر آئی ڈی کے ذریعے اجازت فہرست (سب سے محفوظ)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### کردار پر مبنی رسائی (متبادل)

`allowFrom` ایک سخت اجازت فہرست ہے۔ جب سیٹ ہو تو صرف وہی یوزر آئی ڈیز مجاز ہوں گی۔
اگر آپ کردار پر مبنی رسائی چاہتے ہیں تو `allowFrom` کو غیر سیٹ چھوڑ دیں اور اس کے بجائے `allowedRoles` کنفیگر کریں:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### @mention کی شرط غیر فعال کریں

بطورِ طے شدہ، `requireMention`، `true` ہوتا ہے۔ تمام پیغامات پر جواب دینے کے لیے اسے غیر فعال کریں:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## خرابیوں کا ازالہ

سب سے پہلے، تشخیصی کمانڈز چلائیں:

```bash
openclaw doctor
openclaw channels status --probe
```

### بوٹ پیغامات پر جواب نہیں دیتا

**رسائی کنٹرول چیک کریں:** یقینی بنائیں کہ آپ کا یوزر آئی ڈی `allowFrom` میں ہے، یا عارضی طور پر
`allowFrom` ہٹا دیں اور جانچ کے لیے `allowedRoles: ["all"]` سیٹ کریں۔

**چیک کریں کہ بوٹ چینل میں ہے:** بوٹ کو `channel` میں متعین چینل میں شامل ہونا لازم ہے۔

### ٹوکن کے مسائل

**"Failed to connect" یا تصدیقی غلطیاں:**

- تصدیق کریں کہ `accessToken` OAuth ایکسس ٹوکن کی قدر ہے (عموماً `oauth:` سابقہ سے شروع ہوتی ہے)
- چیک کریں کہ ٹوکن میں `chat:read` اور `chat:write` اسکوپس ہیں
- اگر ٹوکن ریفریش استعمال کر رہے ہیں تو تصدیق کریں کہ `clientSecret` اور `refreshToken` سیٹ ہیں

### ٹوکن ریفریش کام نہیں کر رہا

**ریفریش ایونٹس کے لیے لاگز چیک کریں:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

اگر آپ دیکھیں "token refresh disabled (no refresh token)":

- یقینی بنائیں کہ `clientSecret` فراہم کیا گیا ہے
- یقینی بنائیں کہ `refreshToken` فراہم کیا گیا ہے

## کنفیگ

**اکاؤنٹ کنفیگ:**

- `username` - بوٹ یوزرنیم
- `accessToken` - OAuth ایکسس ٹوکن بمع `chat:read` اور `chat:write`
- `clientId` - Twitch Client ID (Token Generator یا آپ کی ایپ سے)
- `channel` - شامل ہونے والا چینل (لازم)
- `enabled` - اس اکاؤنٹ کو فعال کریں (ڈیفالٹ: `true`)
- `clientSecret` - اختیاری: خودکار ٹوکن ریفریش کے لیے
- `refreshToken` - اختیاری: خودکار ٹوکن ریفریش کے لیے
- `expiresIn` - ٹوکن کی میعاد سیکنڈز میں
- `obtainmentTimestamp` - ٹوکن حاصل کرنے کا ٹائم اسٹیمپ
- `allowFrom` - یوزر آئی ڈی اجازت فہرست
- `allowedRoles` - کردار پر مبنی رسائی کنٹرول (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - @mention درکار (ڈیفالٹ: `true`)

**فراہم کنندہ کے اختیارات:**

- `channels.twitch.enabled` - چینل اسٹارٹ اپ کو فعال/غیرفعال کریں
- `channels.twitch.username` - بوٹ یوزرنیم (سادہ سنگل اکاؤنٹ کنفیگ)
- `channels.twitch.accessToken` - OAuth ایکسس ٹوکن (سادہ سنگل اکاؤنٹ کنفیگ)
- `channels.twitch.clientId` - Twitch Client ID (سادہ سنگل اکاؤنٹ کنفیگ)
- `channels.twitch.channel` - شامل ہونے والا چینل (سادہ سنگل اکاؤنٹ کنفیگ)
- `channels.twitch.accounts.<accountName>` - ملٹی اکاؤنٹ کنفیگ (اوپر کے تمام اکاؤنٹ فیلڈز)

مکمل مثال:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## اوزار کی کارروائیاں

ایجنٹ `twitch` کو اس ایکشن کے ساتھ کال کر سکتا ہے:

- `send` - چینل میں پیغام بھیجیں

مثال:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## حفاظت و آپریشنز

- **ٹوکنز کو پاس ورڈز کی طرح برتیں** — ٹوکنز کو کبھی git میں کمٹ نہ کریں
- **طویل مدتی بوٹس** کے لیے **خودکار ٹوکن ریفریش** استعمال کریں
- **رسائی کنٹرول** کے لیے یوزرنیمز کے بجائے **یوزر آئی ڈی اجازت فہرستیں** استعمال کریں
- **لاگز مانیٹر کریں** تاکہ ٹوکن ریفریش ایونٹس اور کنکشن اسٹیٹس نظر میں رہیں
- **اسکوپس کم سے کم رکھیں** — صرف `chat:read` اور `chat:write` کی درخواست کریں
- **اگر مسئلہ برقرار ہو**: اس بات کی تصدیق کے بعد کہ کوئی اور پراسیس سیشن کا مالک نہیں، گیٹ وے ری اسٹارٹ کریں

## حدود

- فی پیغام **500 حروف** (الفاظ کی حدود پر خودکار تقسیم)
- تقسیم سے پہلے Markdown ہٹا دیا جاتا ہے
- کوئی ریٹ لِمٹنگ نہیں (Twitch کی بلٹ اِن ریٹ لِمٹس استعمال ہوتی ہیں)
