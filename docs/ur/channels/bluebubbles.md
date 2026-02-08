---
summary: "BlueBubbles macOS سرور کے ذریعے iMessage (REST ارسال/وصول، ٹائپنگ، ری ایکشنز، pairing، اور اعلیٰ درجے کی کارروائیاں)."
read_when:
  - BlueBubbles چینل سیٹ اپ کرتے وقت
  - webhook pairing کی خرابیوں کا ازالہ
  - macOS پر iMessage کی کنفیگریشن
title: "BlueBubbles"
x-i18n:
  source_path: channels/bluebubbles.md
  source_hash: a5208867c934460a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:18Z
---

# BlueBubbles (macOS REST)

حیثیت: بنڈلڈ پلگ اِن جو HTTP کے ذریعے BlueBubbles macOS سرور سے بات کرتا ہے۔ **iMessage انضمام کے لیے سفارش کردہ** کیونکہ اس کا API زیادہ بھرپور ہے اور legacy imsg چینل کے مقابلے میں سیٹ اپ آسان ہے۔

## جائزہ

- macOS پر BlueBubbles ہیلپر ایپ کے ذریعے چلتا ہے ([bluebubbles.app](https://bluebubbles.app)).
- سفارش/جانچا گیا: macOS Sequoia (15)۔ macOS Tahoe (26) کام کرتا ہے؛ تاہم Tahoe پر فی الحال edit ٹوٹا ہوا ہے، اور گروپ آئیکن اپڈیٹس کامیابی رپورٹ کر سکتی ہیں مگر sync نہیں ہوتیں۔
- OpenClaw اس سے REST API کے ذریعے بات کرتا ہے (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- آنے والے پیغامات webhooks کے ذریعے موصول ہوتے ہیں؛ باہر جانے والے جوابات، ٹائپنگ اشارے، read receipts، اور tapbacks REST کالز ہیں۔
- attachments اور stickers کو inbound میڈیا کے طور پر ingest کیا جاتا ہے (اور جہاں ممکن ہو ایجنٹ کو دکھایا جاتا ہے)۔
- Pairing/allowlist دیگر چینلز کی طرح ہی کام کرتی ہے (`/channels/pairing` وغیرہ) بذریعہ `channels.bluebubbles.allowFrom` + pairing codes۔
- ری ایکشنز کو سسٹم ایونٹس کے طور پر ظاہر کیا جاتا ہے بالکل Slack/Telegram کی طرح، تاکہ ایجنٹس جواب دینے سے پہلے انہیں "mention" کر سکیں۔
- اعلیٰ درجے کی خصوصیات: edit، unsend، reply threading، message effects، گروپ مینجمنٹ۔

## فوری آغاز

1. اپنے Mac پر BlueBubbles سرور انسٹال کریں ([bluebubbles.app/install](https://bluebubbles.app/install) پر ہدایات دیکھیں)۔
2. BlueBubbles کنفیگ میں web API فعال کریں اور پاس ورڈ سیٹ کریں۔
3. `openclaw onboard` چلائیں اور BlueBubbles منتخب کریں، یا دستی طور پر کنفیگر کریں:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. BlueBubbles webhooks کو اپنے gateway کی طرف پوائنٹ کریں (مثال: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)۔
5. gateway شروع کریں؛ یہ webhook ہینڈلر رجسٹر کرے گا اور pairing شروع ہو جائے گی۔

## Messages.app کو فعال رکھنا (VM / headless سیٹ اپس)

کچھ macOS VM / ہمیشہ آن سیٹ اپس میں Messages.app “idle” ہو سکتی ہے (آنے والے ایونٹس اس وقت تک رک جاتے ہیں جب تک ایپ کھولی/foreground نہ کی جائے)۔ ایک سادہ workaround یہ ہے کہ **ہر 5 منٹ بعد Messages کو poke کیا جائے** بذریعہ AppleScript + LaunchAgent۔

### 1) AppleScript محفوظ کریں

اس نام سے محفوظ کریں:

- `~/Scripts/poke-messages.scpt`

مثالی اسکرپٹ (non-interactive؛ فوکس نہیں چھینتا):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2) LaunchAgent انسٹال کریں

اس نام سے محفوظ کریں:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

نوٹس:

- یہ **ہر 300 سیکنڈ** اور **لاگ اِن پر** چلتا ہے۔
- پہلی بار چلانے پر macOS **Automation** پرامپٹس آ سکتی ہیں (`osascript` → Messages)۔ انہیں اسی user سیشن میں منظور کریں جو LaunchAgent چلاتا ہے۔

لوڈ کریں:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## آن بورڈنگ

BlueBubbles انٹرایکٹو سیٹ اپ وزرڈ میں دستیاب ہے:

```
openclaw onboard
```

وزرڈ درج ذیل کے لیے پوچھتا ہے:

- **Server URL** (لازم): BlueBubbles سرور ایڈریس (مثلاً `http://192.168.1.100:1234`)
- **Password** (لازم): BlueBubbles Server سیٹنگز سے API پاس ورڈ
- **Webhook path** (اختیاری): بطورِ طے شدہ `/bluebubbles-webhook`
- **DM policy**: pairing، allowlist، open، یا disabled
- **Allow list**: فون نمبرز، ای میلز، یا چیٹ ٹارگٹس

آپ CLI کے ذریعے بھی BlueBubbles شامل کر سکتے ہیں:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## رسائی کا کنٹرول (DMs + گروپس)

DMs:

- بطورِ طے شدہ: `channels.bluebubbles.dmPolicy = "pairing"`۔
- نامعلوم ارسال کنندگان کو pairing code ملتا ہے؛ منظوری تک پیغامات نظرانداز کیے جاتے ہیں (codes 1 گھنٹے بعد ختم ہو جاتے ہیں)۔
- منظوری کے طریقے:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Pairing ڈیفالٹ token exchange ہے۔ تفصیل: [Pairing](/channels/pairing)

Groups:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (بطورِ طے شدہ: `allowlist`)۔
- `channels.bluebubbles.groupAllowFrom` یہ کنٹرول کرتا ہے کہ جب `allowlist` سیٹ ہو تو گروپس میں کون ٹرگر کر سکتا ہے۔

### Mention gating (گروپس)

BlueBubbles گروپ چیٹس کے لیے mention gating سپورٹ کرتا ہے، جو iMessage/WhatsApp کے رویّے کے مطابق ہے:

- mentions کی شناخت کے لیے `agents.list[].groupChat.mentionPatterns` (یا `messages.groupChat.mentionPatterns`) استعمال کرتا ہے۔
- جب کسی گروپ کے لیے `requireMention` فعال ہو، ایجنٹ صرف mention ہونے پر جواب دیتا ہے۔
- مجاز ارسال کنندگان کی control کمانڈز mention gating کو bypass کرتی ہیں۔

ہر گروپ کی کنفیگریشن:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Command gating

- Control کمانڈز (مثلاً `/config`, `/model`) کے لیے اجازت درکار ہوتی ہے۔
- کمانڈ کی اجازت طے کرنے کے لیے `allowFrom` اور `groupAllowFrom` استعمال ہوتے ہیں۔
- مجاز ارسال کنندگان گروپس میں mention کے بغیر بھی control کمانڈز چلا سکتے ہیں۔

## ٹائپنگ + read receipts

- **Typing indicators**: جواب تیار ہونے سے پہلے اور دورانِ تیاری خودکار طور پر بھیجے جاتے ہیں۔
- **Read receipts**: `channels.bluebubbles.sendReadReceipts` کے ذریعے کنٹرول ہوتے ہیں (بطورِ طے شدہ: `true`)۔
- **Typing indicators**: OpenClaw typing start ایونٹس بھیجتا ہے؛ BlueBubbles ارسال یا timeout پر typing خود بخود clear کر دیتا ہے (DELETE کے ذریعے دستی stop غیر قابلِ اعتماد ہے)۔

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## اعلیٰ درجے کی کارروائیاں

BlueBubbles کنفیگ میں فعال ہونے پر اعلیٰ درجے کی میسج کارروائیوں کو سپورٹ کرتا ہے:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

دستیاب کارروائیاں:

- **react**: tapback ری ایکشنز شامل/ہٹائیں (`messageId`, `emoji`, `remove`)
- **edit**: بھیجے گئے پیغام میں ترمیم کریں (`messageId`, `text`)
- **unsend**: پیغام واپس لیں (`messageId`)
- **reply**: مخصوص پیغام کو جواب دیں (`messageId`, `text`, `to`)
- **sendWithEffect**: iMessage ایفیکٹ کے ساتھ بھیجیں (`text`, `to`, `effectId`)
- **renameGroup**: گروپ چیٹ کا نام تبدیل کریں (`chatGuid`, `displayName`)
- **setGroupIcon**: گروپ چیٹ کا آئیکن/تصویر سیٹ کریں (`chatGuid`, `media`) — macOS 26 Tahoe پر غیر مستحکم (API کامیابی لوٹا سکتی ہے مگر آئیکن sync نہیں ہوتا)۔
- **addParticipant**: کسی کو گروپ میں شامل کریں (`chatGuid`, `address`)
- **removeParticipant**: کسی کو گروپ سے ہٹائیں (`chatGuid`, `address`)
- **leaveGroup**: گروپ چیٹ چھوڑیں (`chatGuid`)
- **sendAttachment**: میڈیا/فائلیں بھیجیں (`to`, `buffer`, `filename`, `asVoice`)
  - Voice memos: `asVoice: true` کو **MP3** یا **CAF** آڈیو کے ساتھ سیٹ کریں تاکہ iMessage voice message کے طور پر بھیجا جائے۔ BlueBubbles voice memos بھیجتے وقت MP3 → CAF میں تبدیل کرتا ہے۔

### Message IDs (مختصر بمقابلہ مکمل)

OpenClaw ٹوکنز بچانے کے لیے _مختصر_ message IDs دکھا سکتا ہے (مثلاً `1`, `2`)۔

- `MessageSid` / `ReplyToId` مختصر IDs ہو سکتے ہیں۔
- `MessageSidFull` / `ReplyToIdFull` فراہم کنندہ کے مکمل IDs رکھتے ہیں۔
- مختصر IDs میموری میں ہوتے ہیں؛ ری اسٹارٹ یا cache eviction پر ختم ہو سکتے ہیں۔
- کارروائیاں مختصر یا مکمل `messageId` قبول کرتی ہیں، مگر اگر مختصر IDs دستیاب نہ رہیں تو ایرر آئے گا۔

پائیدار آٹومیشنز اور اسٹوریج کے لیے مکمل IDs استعمال کریں:

- Templates: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Context: inbound payloads میں `MessageSidFull` / `ReplyToIdFull`

Template variables کے لیے [Configuration](/gateway/configuration) دیکھیں۔

## Block streaming

یہ کنٹرول کریں کہ جوابات ایک ہی پیغام کے طور پر بھیجے جائیں یا بلاکس میں stream ہوں:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## میڈیا + حدود

- آنے والے attachments ڈاؤن لوڈ ہو کر میڈیا cache میں محفوظ ہوتے ہیں۔
- میڈیا حد `channels.bluebubbles.mediaMaxMb` کے ذریعے (بطورِ طے شدہ: 8 MB)۔
- باہر جانے والا متن `channels.bluebubbles.textChunkLimit` تک chunk کیا جاتا ہے (بطورِ طے شدہ: 4000 حروف)۔

## کنفیگریشن حوالہ

مکمل کنفیگریشن: [Configuration](/gateway/configuration)

Provider اختیارات:

- `channels.bluebubbles.enabled`: چینل فعال/غیرفعال کریں۔
- `channels.bluebubbles.serverUrl`: BlueBubbles REST API بیس URL۔
- `channels.bluebubbles.password`: API پاس ورڈ۔
- `channels.bluebubbles.webhookPath`: Webhook endpoint پاتھ (بطورِ طے شدہ: `/bluebubbles-webhook`)۔
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (بطورِ طے شدہ: `pairing`)۔
- `channels.bluebubbles.allowFrom`: DM allowlist (handles، emails، E.164 نمبرز، `chat_id:*`, `chat_guid:*`)۔
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (بطورِ طے شدہ: `allowlist`)۔
- `channels.bluebubbles.groupAllowFrom`: گروپ sender allowlist۔
- `channels.bluebubbles.groups`: ہر گروپ کی کنفیگ (`requireMention`، وغیرہ)۔
- `channels.bluebubbles.sendReadReceipts`: read receipts بھیجیں (بطورِ طے شدہ: `true`)۔
- `channels.bluebubbles.blockStreaming`: block streaming فعال کریں (بطورِ طے شدہ: `false`; streaming replies کے لیے لازم)۔
- `channels.bluebubbles.textChunkLimit`: باہر جانے والے chunk سائز (حروف میں) (بطورِ طے شدہ: 4000)۔
- `channels.bluebubbles.chunkMode`: `length` (بطورِ طے شدہ) صرف اس وقت split کرتا ہے جب `textChunkLimit` سے تجاوز ہو؛ `newline` لمبائی کے مطابق chunking سے پہلے خالی سطور (پیراگراف حدود) پر split کرتا ہے۔
- `channels.bluebubbles.mediaMaxMb`: آنے والے میڈیا کی حد (MB میں) (بطورِ طے شدہ: 8)۔
- `channels.bluebubbles.historyLimit`: context کے لیے زیادہ سے زیادہ گروپ پیغامات (0 غیر فعال کرتا ہے)۔
- `channels.bluebubbles.dmHistoryLimit`: DM ہسٹری حد۔
- `channels.bluebubbles.actions`: مخصوص کارروائیاں فعال/غیرفعال کریں۔
- `channels.bluebubbles.accounts`: multi-account کنفیگریشن۔

متعلقہ global اختیارات:

- `agents.list[].groupChat.mentionPatterns` (یا `messages.groupChat.mentionPatterns`)۔
- `messages.responsePrefix`۔

## ایڈریسنگ / ترسیلی اہداف

مستحکم routing کے لیے `chat_guid` کو ترجیح دیں:

- `chat_guid:iMessage;-;+15555550123` (گروپس کے لیے ترجیحی)
- `chat_id:123`
- `chat_identifier:...`
- براہِ راست handles: `+15555550123`, `user@example.com`
  - اگر کسی براہِ راست handle کے لیے موجودہ DM چیٹ نہ ہو تو OpenClaw `POST /api/v1/chat/new` کے ذریعے ایک بنا دے گا۔ اس کے لیے BlueBubbles Private API کا فعال ہونا ضروری ہے۔

## سکیورٹی

- Webhook درخواستوں کی تصدیق `guid`/`password` query params یا headers کو `channels.bluebubbles.password` سے موازنہ کر کے کی جاتی ہے۔ `localhost` سے آنے والی درخواستیں بھی قبول ہوتی ہیں۔
- API پاس ورڈ اور webhook endpoint کو خفیہ رکھیں (انہیں credentials کی طرح برتیں)۔
- Localhost trust کا مطلب یہ ہے کہ same-host reverse proxy غیر ارادی طور پر پاس ورڈ کو bypass کر سکتا ہے۔ اگر آپ gateway کو proxy کرتے ہیں تو proxy پر auth لازمی بنائیں اور `gateway.trustedProxies` کنفیگر کریں۔ دیکھیں [Gateway security](/gateway/security#reverse-proxy-configuration)۔
- اگر BlueBubbles سرور کو اپنے LAN سے باہر expose کر رہے ہیں تو HTTPS + firewall قواعد فعال کریں۔

## خرابیوں کا ازالہ

- اگر typing/read ایونٹس کام کرنا بند کر دیں تو BlueBubbles webhook لاگز چیک کریں اور تصدیق کریں کہ gateway پاتھ `channels.bluebubbles.webhookPath` سے میل کھاتا ہے۔
- Pairing codes ایک گھنٹے بعد ختم ہو جاتے ہیں؛ `openclaw pairing list bluebubbles` اور `openclaw pairing approve bluebubbles <code>` استعمال کریں۔
- ری ایکشنز کے لیے BlueBubbles private API درکار ہے (`POST /api/v1/message/react`)؛ یقینی بنائیں کہ سرور ورژن اسے فراہم کرتا ہے۔
- Edit/unsend کے لیے macOS 13+ اور ہم آہنگ BlueBubbles سرور ورژن درکار ہے۔ macOS 26 (Tahoe) پر private API تبدیلیوں کی وجہ سے edit فی الحال خراب ہے۔
- macOS 26 (Tahoe) پر گروپ آئیکن اپڈیٹس غیر مستحکم ہو سکتی ہیں: API کامیابی لوٹا سکتی ہے مگر نیا آئیکن sync نہیں ہوتا۔
- OpenClaw BlueBubbles سرور کے macOS ورژن کی بنیاد پر معروف طور پر خراب کارروائیوں کو خود بخود چھپا دیتا ہے۔ اگر macOS 26 (Tahoe) پر edit پھر بھی نظر آئے تو `channels.bluebubbles.actions.edit=false` کے ذریعے دستی طور پر اسے غیر فعال کریں۔
- اسٹیٹس/ہیلتھ معلومات کے لیے: `openclaw status --all` یا `openclaw status --deep`۔

عمومی چینل ورک فلو کے حوالے کے لیے [Channels](/channels) اور [Plugins](/tools/plugin) گائیڈ دیکھیں۔
