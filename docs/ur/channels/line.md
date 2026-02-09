---
summary: "LINE میسجنگ API پلگ اِن کی سیٹ اپ، کنفیگ اور استعمال"
read_when:
  - آپ OpenClaw کو LINE سے جوڑنا چاہتے ہیں
  - آپ کو LINE ویب ہُک اور اسناد کی سیٹ اپ درکار ہے
  - آپ LINE کے مخصوص پیغام اختیارات چاہتے ہیں
title: LINE
---

# LINE (plugin)

LINE connects to OpenClaw via the LINE Messaging API. The plugin runs as a webhook
receiver on the gateway and uses your channel access token + channel secret for
authentication.

Status: supported via plugin. Direct messages, group chats, media, locations, Flex
messages, template messages, and quick replies are supported. Reactions and threads
are not supported.

## Plugin required

LINE پلگ اِن انسٹال کریں:

```bash
openclaw plugins install @openclaw/line
```

لوکل چیک آؤٹ (جب git ریپو سے چلایا جا رہا ہو):

```bash
openclaw plugins install ./extensions/line
```

## Setup

1. LINE Developers اکاؤنٹ بنائیں اور کنسول کھولیں:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. ایک Provider بنائیں (یا منتخب کریں) اور **Messaging API** چینل شامل کریں۔
3. چینل سیٹنگز سے **Channel access token** اور **Channel secret** کاپی کریں۔
4. Messaging API سیٹنگز میں **Use webhook** فعال کریں۔
5. ویب ہُک URL کو اپنے گیٹ وے اینڈپوائنٹ پر سیٹ کریں (HTTPS لازمی ہے):

```
https://gateway-host/line/webhook
```

The gateway responds to LINE’s webhook verification (GET) and inbound events (POST).
If you need a custom path, set `channels.line.webhookPath` or
`channels.line.accounts.<id>.webhookPath` and update the URL accordingly.

## Configure

کم از کم کنفیگ:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Env vars (صرف ڈیفالٹ اکاؤنٹ):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

ٹوکن/سیکرٹ فائلیں:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

متعدد اکاؤنٹس:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Access control

براہِ راست پیغامات بطورِ ڈیفالٹ پیئرنگ پر سیٹ ہوتے ہیں۔ نامعلوم بھیجنے والوں کو ایک پیئرنگ کوڈ ملتا ہے اور منظوری تک ان کے پیغامات نظرانداز کر دیے جاتے ہیں۔

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

اجازت فہرستیں اور پالیسیاں:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: DMs کے لیے اجازت یافتہ LINE یوزر IDs
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: گروپس کے لیے اجازت یافتہ LINE یوزر IDs
- فی گروپ اووررائیڈز: `channels.line.groups.<groupId>`.allowFrom\`

LINE IDs are case-sensitive. درست IDs اس طرح نظر آتے ہیں:

- صارف: `U` + 32 ہیکس حروف
- گروپ: `C` + 32 ہیکس حروف
- روم: `R` + 32 ہیکس حروف

## Message behavior

- متن کو 5000 حروف پر ٹکڑوں میں تقسیم کیا جاتا ہے۔
- مارک ڈاؤن فارمیٹنگ ہٹا دی جاتی ہے؛ کوڈ بلاکس اور ٹیبلز کو جہاں ممکن ہو Flex
  کارڈز میں تبدیل کیا جاتا ہے۔
- اسٹریمنگ جوابات بفر کیے جاتے ہیں؛ ایجنٹ کے کام کرنے کے دوران LINE مکمل ٹکڑوں کے ساتھ
  لوڈنگ اینیمیشن وصول کرتا ہے۔
- میڈیا ڈاؤن لوڈز `channels.line.mediaMaxMb` کے ذریعے محدود ہوتے ہیں (ڈیفالٹ 10)۔

## Channel data (rich messages)

فوری جوابات، مقامات، Flex کارڈز، یا ٹیمپلیٹ
پیغامات بھیجنے کے لیے `channelData.line` استعمال کریں۔

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

LINE پلگ اِن Flex پیغام پری سیٹس کے لیے ایک `/card` کمانڈ بھی فراہم کرتا ہے:

```
/card info "Welcome" "Thanks for joining!"
```

## Troubleshooting

- **ویب ہُک ویریفیکیشن ناکام:** یقینی بنائیں کہ ویب ہُک URL HTTPS ہے اور
  `channelSecret` LINE کنسول سے مطابقت رکھتا ہے۔
- **کوئی اِن باؤنڈ ایونٹس نہیں:** تصدیق کریں کہ ویب ہُک پاتھ `channels.line.webhookPath` سے
  مطابقت رکھتا ہے اور گیٹ وے LINE سے قابلِ رسائی ہے۔
- **میڈیا ڈاؤن لوڈ کی غلطیاں:** اگر میڈیا ڈیفالٹ حد سے بڑا ہو تو
  `channels.line.mediaMaxMb` بڑھائیں۔
