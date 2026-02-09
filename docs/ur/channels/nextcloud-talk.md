---
summary: "Nextcloud Talk کی معاونت کی حیثیت، صلاحیتیں، اور کنفیگریشن"
read_when:
  - Nextcloud Talk چینل کی خصوصیات پر کام کرتے وقت
title: "Nextcloud Talk"
---

# Nextcloud Talk (پلگ اِن)

Status: supported via plugin (webhook bot). Direct messages, rooms, reactions, and markdown messages are supported.

## پلگ اِن درکار ہے

Nextcloud Talk بطور پلگ اِن فراہم کیا جاتا ہے اور کور انسٹال کے ساتھ شامل نہیں ہوتا۔

CLI کے ذریعے انسٹال کریں (npm رجسٹری):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

لوکل چیک آؤٹ (جب git ریپو سے چلایا جا رہا ہو):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

اگر آپ کنفیگر/آن بورڈنگ کے دوران Nextcloud Talk منتخب کرتے ہیں اور git چیک آؤٹ کا پتا چلتا ہے،
تو OpenClaw خودکار طور پر لوکل انسٹال راستہ پیش کرے گا۔

تفصیلات: [Plugins](/tools/plugin)

## فوری سیٹ اپ (مبتدی)

1. Nextcloud Talk پلگ اِن انسٹال کریں۔

2. اپنے Nextcloud سرور پر ایک بوٹ بنائیں:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. ہدف روم کی سیٹنگز میں بوٹ کو فعال کریں۔

4. OpenClaw کنفیگر کریں:
   - کنفیگ: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - یا env: `NEXTCLOUD_TALK_BOT_SECRET` (صرف ڈیفالٹ اکاؤنٹ)

5. Gateway ری اسٹارٹ کریں (یا آن بورڈنگ مکمل کریں)۔

کم از کم کنفیگ:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## نوٹس

- Bots cannot initiate DMs. The user must message the bot first.
- Webhook URL کا Gateway سے قابلِ رسائی ہونا لازم ہے؛ اگر پراکسی کے پیچھے ہوں تو `webhookPublicUrl` سیٹ کریں۔
- میڈیا اپ لوڈز بوٹ API کے ذریعے معاونت یافتہ نہیں؛ میڈیا URLs کے طور پر بھیجا جاتا ہے۔
- Webhook پے لوڈ DMs اور رومز میں فرق نہیں کرتا؛ روم ٹائپ کی تلاش فعال کرنے کے لیے `apiUser` + `apiPassword` سیٹ کریں (ورنہ DMs کو رومز سمجھا جاتا ہے)۔

## رسائی کا کنٹرول (DMs)

- ڈیفالٹ: `channels.nextcloud-talk.dmPolicy = "pairing"`۔ Unknown senders get a pairing code.
- منظوری کے طریقے:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- عوامی DMs: `channels.nextcloud-talk.dmPolicy="open"` کے ساتھ `channels.nextcloud-talk.allowFrom=["*"]`۔
- `allowFrom` صرف Nextcloud صارف IDs سے مطابقت رکھتا ہے؛ ڈسپلے نام نظر انداز کیے جاتے ہیں۔

## رومز (گروپس)

- ڈیفالٹ: `channels.nextcloud-talk.groupPolicy = "allowlist"` (ذکر/مینشن پر مبنی گیٹنگ)۔
- `channels.nextcloud-talk.rooms` کے ساتھ رومز کو اجازت فہرست میں شامل کریں:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- کسی بھی روم کی اجازت نہ دینے کے لیے، اجازت فہرست خالی رکھیں یا `channels.nextcloud-talk.groupPolicy="disabled"` سیٹ کریں۔

## صلاحیتیں

| خصوصیت             | حیثیت             |
| ------------------ | ----------------- |
| براہِ راست پیغامات | معاونت یافتہ      |
| رومز               | معاونت یافتہ      |
| تھریڈز             | معاونت یافتہ نہیں |
| میڈیا              | صرف URL           |
| ری ایکشنز          | معاونت یافتہ      |
| نیٹو کمانڈز        | معاونت یافتہ نہیں |

## کنفیگریشن حوالہ (Nextcloud Talk)

مکمل کنفیگریشن: [Configuration](/gateway/configuration)

فراہم کنندہ کے اختیارات:

- `channels.nextcloud-talk.enabled`: چینل اسٹارٹ اپ کو فعال/غیرفعال کریں۔
- `channels.nextcloud-talk.baseUrl`: Nextcloud انسٹینس URL۔
- `channels.nextcloud-talk.botSecret`: بوٹ کا مشترکہ سیکرٹ۔
- `channels.nextcloud-talk.botSecretFile`: سیکرٹ فائل کا راستہ۔
- `channels.nextcloud-talk.apiUser`: روم تلاش کے لیے API صارف (DM کی شناخت)۔
- `channels.nextcloud-talk.apiPassword`: روم تلاش کے لیے API/ایپ پاس ورڈ۔
- `channels.nextcloud-talk.apiPasswordFile`: API پاس ورڈ فائل کا راستہ۔
- `channels.nextcloud-talk.webhookPort`: webhook لسٹنر پورٹ (ڈیفالٹ: 8788)۔
- `channels.nextcloud-talk.webhookHost`: webhook ہوسٹ (ڈیفالٹ: 0.0.0.0)۔
- `channels.nextcloud-talk.webhookPath`: webhook پاتھ (ڈیفالٹ: /nextcloud-talk-webhook)۔
- `channels.nextcloud-talk.webhookPublicUrl`: بیرونی طور پر قابلِ رسائی webhook URL۔
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`۔
- `channels.nextcloud-talk.allowFrom`: DM allowlist (user IDs). `open` requires `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`۔
- `channels.nextcloud-talk.groupAllowFrom`: گروپ اجازت فہرست (صارف IDs)۔
- `channels.nextcloud-talk.rooms`: ہر روم کی سیٹنگز اور اجازت فہرست۔
- `channels.nextcloud-talk.historyLimit`: گروپ ہسٹری حد (0 غیر فعال کرتا ہے)۔
- `channels.nextcloud-talk.dmHistoryLimit`: DM ہسٹری حد (0 غیر فعال کرتا ہے)۔
- `channels.nextcloud-talk.dms`: فی-DM اوور رائیڈز (historyLimit)۔
- `channels.nextcloud-talk.textChunkLimit`: آؤٹ باؤنڈ متن چنک سائز (حروف)۔
- `channels.nextcloud-talk.chunkMode`: `length` (ڈیفالٹ) یا `newline` تاکہ لمبائی کے مطابق چنکنگ سے پہلے خالی لائنوں (پیراگراف کی حدیں) پر تقسیم کیا جائے۔
- `channels.nextcloud-talk.blockStreaming`: اس چینل کے لیے بلاک اسٹریمنگ غیر فعال کریں۔
- `channels.nextcloud-talk.blockStreamingCoalesce`: بلاک اسٹریمنگ کوالیس ٹیوننگ۔
- `channels.nextcloud-talk.mediaMaxMb`: اِن باؤنڈ میڈیا حد (MB)۔
