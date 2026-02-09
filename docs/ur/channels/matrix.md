---
summary: "Matrix کی معاونت کی حیثیت، صلاحیتیں، اور کنفیگریشن"
read_when:
  - Matrix چینل کی خصوصیات پر کام کرتے وقت
title: "Matrix"
---

# Matrix (plugin)

Matrix ایک کھلا، غیر مرکزی پیغام رسانی پروٹوکول ہے۔ OpenClaw connects as a Matrix **user**
on any homeserver, so you need a Matrix account for the bot. لاگ اِن ہونے کے بعد، آپ بوٹ کو براہِ راست DM کر سکتے ہیں یا اسے کمروں (Matrix "گروپس") میں مدعو کر سکتے ہیں۔ Beeper بھی ایک درست کلائنٹ آپشن ہے، لیکن اس کے لیے E2EE کا فعال ہونا ضروری ہے۔

اسٹیٹس: پلگ اِن کے ذریعے سپورٹ شدہ (@vector-im/matrix-bot-sdk)۔ براہِ راست پیغامات، رومز، تھریڈز، میڈیا، ری ایکشنز، پولز (send + poll-start بطور متن)، لوکیشن، اور E2EE (کرپٹو سپورٹ کے ساتھ)۔

## Plugin required

Matrix ایک پلگ اِن کے طور پر فراہم کیا جاتا ہے اور کور انسٹال میں شامل نہیں ہوتا۔

CLI کے ذریعے انسٹال کریں (npm رجسٹری):

```bash
openclaw plugins install @openclaw/matrix
```

لوکل چیک آؤٹ (جب git ریپو سے چلایا جا رہا ہو):

```bash
openclaw plugins install ./extensions/matrix
```

اگر آپ کنفیگر/آن بورڈنگ کے دوران Matrix کا انتخاب کریں اور git چیک آؤٹ شناخت ہو جائے،
تو OpenClaw خودکار طور پر لوکل انسٹال راستہ پیش کرے گا۔

تفصیلات: [Plugins](/tools/plugin)

## Setup

1. Matrix پلگ اِن انسٹال کریں:
   - npm سے: `openclaw plugins install @openclaw/matrix`
   - لوکل چیک آؤٹ سے: `openclaw plugins install ./extensions/matrix`

2. کسی homeserver پر Matrix اکاؤنٹ بنائیں:
   - ہوسٹنگ کے اختیارات دیکھیں: [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - یا خود ہوسٹ کریں۔

3. بوٹ اکاؤنٹ کے لیے ایک ایکسیس ٹوکن حاصل کریں:

   - Matrix لاگ اِن API استعمال کریں `curl` کے ساتھ اپنے home server پر:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - `matrix.example.org` کو اپنے homeserver URL سے بدلیں۔
   - یا `channels.matrix.userId` + `channels.matrix.password` سیٹ کریں: OpenClaw وہی
     لاگ اِن اینڈپوائنٹ کال کرتا ہے، ایکسیس ٹوکن کو `~/.openclaw/credentials/matrix/credentials.json` میں محفوظ کرتا ہے،
     اور اگلی شروعات پر اسے دوبارہ استعمال کرتا ہے۔

4. اسناد کنفیگر کریں:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (یا `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - یا کنفیگ: `channels.matrix.*`
   - اگر دونوں سیٹ ہوں تو کنفیگ کو ترجیح حاصل ہوگی۔
   - ایکسیس ٹوکن کے ساتھ: صارف ID خودکار طور پر `/whoami` کے ذریعے حاصل کی جاتی ہے۔
   - جب سیٹ ہو، `channels.matrix.userId` مکمل Matrix ID ہونا چاہیے (مثال: `@bot:example.org`)۔

5. Gateway کو ری اسٹارٹ کریں (یا آن بورڈنگ مکمل کریں)۔

6. کسی بھی Matrix کلائنٹ سے بوٹ کے ساتھ DM شروع کریں یا اسے کسی روم میں مدعو کریں
   (Element، Beeper، وغیرہ؛ دیکھیں [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/))۔ Beeper کو E2EE درکار ہے،
   اس لیے `channels.matrix.encryption: true` سیٹ کریں اور ڈیوائس کی تصدیق کریں۔

کم از کم کنفیگ (ایکسیس ٹوکن، صارف ID خودکار طور پر حاصل):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

E2EE کنفیگ (اینڈ ٹو اینڈ انکرپشن فعال):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## Encryption (E2EE)

اینڈ ٹو اینڈ انکرپشن Rust crypto SDK کے ذریعے **معاونت یافتہ** ہے۔

`channels.matrix.encryption: true` کے ساتھ فعال کریں:

- اگر کرپٹو ماڈیول لوڈ ہو جائے تو انکرپٹڈ کمروں کو خودکار طور پر ڈکرپٹ کیا جاتا ہے۔
- آؤٹ باؤنڈ میڈیا انکرپٹڈ کمروں میں بھیجتے وقت انکرپٹ ہوتا ہے۔
- پہلی کنکشن پر، OpenClaw آپ کی دیگر سیشنز سے ڈیوائس ویریفیکیشن کی درخواست کرتا ہے۔
- Verify the device in another Matrix client (Element, etc.) تاکہ کی شیئرنگ فعال ہو سکے۔
- اگر کرپٹو ماڈیول لوڈ نہ ہو سکے تو E2EE غیرفعال ہو جاتا ہے اور انکرپٹڈ کمرے ڈکرپٹ نہیں ہوں گے؛
  OpenClaw ایک وارننگ لاگ کرتا ہے۔
- اگر آپ کو کرپٹو ماڈیول کی عدم موجودگی کی غلطیاں نظر آئیں (مثال کے طور پر، `@matrix-org/matrix-sdk-crypto-nodejs-*`)،
  تو `@matrix-org/matrix-sdk-crypto-nodejs` کے لیے build اسکرپٹس کی اجازت دیں اور
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` چلائیں یا بائنری حاصل کریں
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js` کے ساتھ۔

کرپٹو اسٹیٹ فی اکاؤنٹ + ایکسس ٹوکن کے حساب سے محفوظ ہوتی ہے:
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite ڈیٹابیس)۔ سنک اسٹیٹ اسی کے ساتھ `bot-storage.json` میں موجود ہوتی ہے۔
اگر ایکسس ٹوکن (ڈیوائس) تبدیل ہو جائے تو ایک نیا اسٹور بنایا جاتا ہے اور انکرپٹڈ رومز کے لیے بوٹ کی دوبارہ تصدیق ضروری ہوتی ہے۔

**ڈیوائس کی تصدیق:**
جب E2EE فعال ہو، بوٹ اسٹارٹ اپ پر آپ کے دوسرے سیشنز سے تصدیق کی درخواست کرے گا۔
Element (یا کوئی اور کلائنٹ) کھولیں اور اعتماد قائم کرنے کے لیے تصدیقی درخواست منظور کریں۔
تصدیق کے بعد، بوٹ انکرپٹڈ رومز میں پیغامات ڈی کرپٹ کر سکتا ہے۔

## Routing model

- جوابات ہمیشہ Matrix پر واپس جاتے ہیں۔
- DMs ایجنٹ کے مرکزی سیشن کو شیئر کرتے ہیں؛ کمرے گروپ سیشنز سے میپ ہوتے ہیں۔

## Access control (DMs)

- ڈیفالٹ: `channels.matrix.dm.policy = "pairing"`۔ نامعلوم بھیجنے والوں کو ایک پیئرنگ کوڈ ملتا ہے۔
- منظوری دیں بذریعہ:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- عوامی DMs: `channels.matrix.dm.policy="open"` کے ساتھ `channels.matrix.dm.allowFrom=["*"]`۔
- `channels.matrix.dm.allowFrom` مکمل Matrix یوزر IDs قبول کرتا ہے (مثال: `@user:server`)۔ جب ڈائریکٹری سرچ میں ایک ہی عین میچ ملتا ہے تو وزرڈ ڈسپلے ناموں کو یوزر IDs میں تبدیل کر دیتا ہے۔

## Rooms (groups)

- ڈیفالٹ: `channels.matrix.groupPolicy = "allowlist"` (ذکر/مینشن پر مبنی گیٹنگ)۔ جب ڈیفالٹ سیٹ نہ ہو تو اسے اووررائیڈ کرنے کے لیے `channels.defaults.groupPolicy` استعمال کریں۔
- کمروں کو allowlist کریں `channels.matrix.groups` کے ساتھ (کمرہ IDs یا aliases؛ نام IDs میں ریزولو کیے جاتے ہیں جب ڈائریکٹری سرچ ایک واحد درست میچ تلاش کرے):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` اس کمرے میں خودکار جواب فعال کرتا ہے۔
- `groups."*"` کمروں میں mention gating کے لیے ڈیفالٹس سیٹ کر سکتا ہے۔
- `groupAllowFrom` محدود کرتا ہے کہ کمروں میں کون سے ارسال کنندگان بوٹ کو ٹرگر کر سکتے ہیں (مکمل Matrix صارف IDs)۔
- فی کمرہ `users` allowlists کسی مخصوص کمرے کے اندر ارسال کنندگان کو مزید محدود کر سکتی ہیں (مکمل Matrix صارف IDs استعمال کریں)۔
- کنفیگر وِزارڈ کمرہ allowlists (کمرہ IDs، aliases، یا نام) کے لیے پرامپٹ کرتا ہے اور ناموں کو صرف عین، منفرد میچ پر ریزولو کرتا ہے۔
- اسٹارٹ اپ پر، OpenClaw allowlists میں کمرہ/صارف ناموں کو IDs میں ریزولو کرتا ہے اور میپنگ لاگ کرتا ہے؛ غیر ریزولو شدہ اندراجات allowlist میچنگ کے لیے نظر انداز کر دیے جاتے ہیں۔
- دعوتیں بطورِ طے شدہ خودکار طور پر قبول کی جاتی ہیں؛ کنٹرول کریں `channels.matrix.autoJoin` اور `channels.matrix.autoJoinAllowlist` کے ساتھ۔
- **کوئی کمرہ نہیں** کی اجازت دینے کے لیے، `channels.matrix.groupPolicy: "disabled"` سیٹ کریں (یا خالی allowlist رکھیں)۔
- پرانا کلید: `channels.matrix.rooms` (وہی ساخت جیسی `groups`)۔

## Threads

- جواب تھریڈنگ معاونت یافتہ ہے۔
- `channels.matrix.threadReplies` کنٹرول کرتا ہے کہ جوابات تھریڈز میں رہیں یا نہیں:
  - `off`, `inbound` (ڈیفالٹ), `always`
- `channels.matrix.replyToMode` اس وقت reply-to میٹا ڈیٹا کنٹرول کرتا ہے جب تھریڈ میں جواب نہ دیا جا رہا ہو:
  - `off` (ڈیفالٹ), `first`, `all`

## Capabilities

| Feature         | Status                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Direct messages | ✅ معاونت یافتہ                                                                                                     |
| Rooms           | ✅ معاونت یافتہ                                                                                                     |
| Threads         | ✅ معاونت یافتہ                                                                                                     |
| Media           | ✅ معاونت یافتہ                                                                                                     |
| E2EE            | ✅ معاونت یافتہ (کرپٹو ماڈیول درکار)                                                             |
| Reactions       | ✅ معاونت یافتہ (اوزار کے ذریعے بھیجیں/پڑھیں)                                                    |
| Polls           | ✅ بھیجنا معاونت یافتہ؛ آنے والے پول آغاز کو متن میں تبدیل کیا جاتا ہے (جوابات/اختتام نظر انداز) |
| Location        | ✅ معاونت یافتہ (geo URI؛ altitude نظر انداز)                                                    |
| Native commands | ✅ معاونت یافتہ                                                                                                     |

## Troubleshooting

سب سے پہلے یہ ladder چلائیں:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

پھر ضرورت ہو تو DM pairing اسٹیٹ کی تصدیق کریں:

```bash
openclaw pairing list matrix
```

عام ناکامیاں:

- لاگ اِن ہے مگر کمرے کے پیغامات نظر انداز ہو رہے ہیں: کمرہ `groupPolicy` یا کمرہ allowlist کے ذریعے بلاک ہے۔
- DMs نظر انداز: جب `channels.matrix.dm.policy="pairing"` ہو تو ارسال کنندہ منظوری کا منتظر ہے۔
- انکرپٹڈ کمرے ناکام: کرپٹو سپورٹ یا انکرپشن سیٹنگز میں عدم مطابقت۔

ٹرائیاج فلو کے لیے: [/channels/troubleshooting](/channels/troubleshooting)۔

## Configuration reference (Matrix)

مکمل کنفیگریشن: [Configuration](/gateway/configuration)

Provider options:

- `channels.matrix.enabled`: چینل اسٹارٹ اپ کو فعال/غیرفعال کریں۔
- `channels.matrix.homeserver`: homeserver URL۔
- `channels.matrix.userId`: Matrix صارف ID (ایکسیس ٹوکن کے ساتھ اختیاری)۔
- `channels.matrix.accessToken`: ایکسیس ٹوکن۔
- `channels.matrix.password`: لاگ اِن کے لیے پاس ورڈ (ٹوکن محفوظ کیا جاتا ہے)۔
- `channels.matrix.deviceName`: ڈیوائس ڈسپلے نام۔
- `channels.matrix.encryption`: E2EE فعال کریں (ڈیفالٹ: false)۔
- `channels.matrix.initialSyncLimit`: ابتدائی sync حد۔
- `channels.matrix.threadReplies`: `off | inbound | always` (ڈیفالٹ: inbound)۔
- `channels.matrix.textChunkLimit`: آؤٹ باؤنڈ متن چنک سائز (حروف)۔
- `channels.matrix.chunkMode`: `length` (ڈیفالٹ) یا `newline` تاکہ لمبائی کے مطابق چنکنگ سے پہلے خالی سطروں (پیراگراف حدود) پر تقسیم کیا جائے۔
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (ڈیفالٹ: pairing)۔
- `channels.matrix.dm.allowFrom`: DM الاؤ لسٹ (مکمل Matrix یوزر IDs)۔ `open` کے لیے `"*"` درکار ہے۔ جہاں ممکن ہو، وزرڈ ناموں کو IDs میں تبدیل کرتا ہے۔
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (ڈیفالٹ: allowlist)۔
- `channels.matrix.groupAllowFrom`: گروپ پیغامات کے لیے allowlisted ارسال کنندگان (مکمل Matrix صارف IDs)۔
- `channels.matrix.allowlistOnly`: DMs + کمروں کے لیے allowlist قواعد نافذ کریں۔
- `channels.matrix.groups`: گروپ allowlist + فی کمرہ سیٹنگز میپ۔
- `channels.matrix.rooms`: پرانا گروپ allowlist/کنفیگ۔
- `channels.matrix.replyToMode`: تھریڈز/ٹیگز کے لیے reply-to موڈ۔
- `channels.matrix.mediaMaxMb`: inbound/outbound میڈیا حد (MB)۔
- `channels.matrix.autoJoin`: دعوت ہینڈلنگ (`always | allowlist | off`, ڈیفالٹ: always)۔
- `channels.matrix.autoJoinAllowlist`: خودکار جوائن کے لیے مجاز کمرہ IDs/aliases۔
- `channels.matrix.actions`: فی ایکشن ٹول gating (reactions/messages/pins/memberInfo/channelInfo)۔
