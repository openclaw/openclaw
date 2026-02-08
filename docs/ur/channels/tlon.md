---
summary: "Tlon/Urbit کی معاونت کی حیثیت، صلاحیتیں، اور کنفیگریشن"
read_when:
  - Tlon/Urbit چینل کی خصوصیات پر کام کرتے وقت
title: "Tlon"
x-i18n:
  source_path: channels/tlon.md
  source_hash: 85fd29cda05b4563
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:57Z
---

# Tlon (plugin)

Tlon ایک غیرمرکزی میسنجر ہے جو Urbit پر مبنی ہے۔ OpenClaw آپ کے Urbit ship سے جڑتا ہے اور
DMs اور گروپ چیٹ پیغامات کا جواب دے سکتا ہے۔ گروپس میں جوابات بطورِ طے شدہ @ mention کے ساتھ درکار ہوتے ہیں اور اجازت فہرستوں کے ذریعے مزید محدود کیے جا سکتے ہیں۔

حیثیت: پلگ ان کے ذریعے معاونت یافتہ۔ DMs، گروپ mentions، تھریڈ جوابات، اور صرف متن پر مبنی میڈیا فال بیک
(کیپشن کے ساتھ URL شامل) دستیاب ہیں۔ Reactions، polls، اور native میڈیا اپلوڈز معاونت یافتہ نہیں ہیں۔

## Plugin required

Tlon ایک پلگ ان کے طور پر فراہم کیا جاتا ہے اور کور انسٹال کے ساتھ شامل نہیں ہوتا۔

CLI کے ذریعے انسٹال کریں (npm رجسٹری):

```bash
openclaw plugins install @openclaw/tlon
```

مقامی چیک آؤٹ (جب git ریپو سے چلایا جا رہا ہو):

```bash
openclaw plugins install ./extensions/tlon
```

تفصیلات: [Plugins](/tools/plugin)

## Setup

1. Tlon پلگ ان انسٹال کریں۔
2. اپنے ship کا URL اور لاگ اِن کوڈ جمع کریں۔
3. `channels.tlon` کنفیگر کریں۔
4. gateway کو ری اسٹارٹ کریں۔
5. بوٹ کو DM کریں یا کسی گروپ چینل میں اس کا ذکر کریں۔

کم از کم کنفیگ (سنگل اکاؤنٹ):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## Group channels

خودکار ڈسکوری بطورِ طے شدہ فعال ہے۔ آپ چینلز کو دستی طور پر بھی پن کر سکتے ہیں:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

خودکار ڈسکوری غیر فعال کریں:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Access control

DM اجازت فہرست (خالی = سب کی اجازت):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

گروپ مجاز کاری (بطورِ طے شدہ محدود):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Delivery targets (CLI/cron)

انہیں `openclaw message send` یا cron ڈیلیوری کے ساتھ استعمال کریں:

- DM: `~sampel-palnet` یا `dm/~sampel-palnet`
- Group: `chat/~host-ship/channel` یا `group:~host-ship/channel`

## Notes

- گروپس میں جواب دینے کے لیے mention درکار ہے (مثلاً `~your-bot-ship`)۔
- تھریڈ جوابات: اگر آنے والا پیغام کسی تھریڈ میں ہو تو OpenClaw اسی تھریڈ میں جواب دیتا ہے۔
- میڈیا: `sendMedia` متن + URL پر فال بیک کرتا ہے (native اپلوڈ نہیں)۔
