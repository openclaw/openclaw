---
summary: "BlueBubbles macOS سرور کے ذریعے iMessage (REST ارسال/وصول، ٹائپنگ، ری ایکشنز، pairing، اور اعلیٰ درجے کی کارروائیاں)."
read_when:
  - BlueBubbles چینل سیٹ اپ کرتے وقت
  - webhook pairing کی خرابیوں کا ازالہ
  - macOS پر iMessage کی کنفیگریشن
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

Status: bundled plugin that talks to the BlueBubbles macOS server over HTTP. **Recommended for iMessage integration** due to its richer API and easier setup compared to the legacy imsg channel.

## جائزہ

- macOS پر BlueBubbles ہیلپر ایپ کے ذریعے چلتا ہے ([bluebubbles.app](https://bluebubbles.app)).
- Recommended/tested: macOS Sequoia (15). macOS Tahoe (26) works; edit is currently broken on Tahoe, and group icon updates may report success but not sync.
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

Some macOS VM / always-on setups can end up with Messages.app going “idle” (incoming events stop until the app is opened/foregrounded). A simple workaround is to **poke Messages every 5 minutes** using an AppleScript + LaunchAgent.

### 1. AppleScript محفوظ کریں

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

### 2. LaunchAgent انسٹال کریں

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
- The first run may trigger macOS **Automation** prompts (`osascript` → Messages). Approve them in the same user session that runs the LaunchAgent.

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
- Pairing is the default token exchange. Details: [Pairing](/channels/pairing)

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
  - Voice memos: set `asVoice: true` with **MP3** or **CAF** audio to send as an iMessage voice message. BlueBubbles converts MP3 → CAF when sending voice memos.

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
  - If a direct handle does not have an existing DM chat, OpenClaw will create one via `POST /api/v1/chat/new`. This requires the BlueBubbles Private API to be enabled.

## سکیورٹی

- Webhook requests are authenticated by comparing `guid`/`password` query params or headers against `channels.bluebubbles.password`. Requests from `localhost` are also accepted.
- API پاس ورڈ اور webhook endpoint کو خفیہ رکھیں (انہیں credentials کی طرح برتیں)۔
- Localhost trust means a same-host reverse proxy can unintentionally bypass the password. If you proxy the gateway, require auth at the proxy and configure `gateway.trustedProxies`. See [Gateway security](/gateway/security#reverse-proxy-configuration).
- اگر BlueBubbles سرور کو اپنے LAN سے باہر expose کر رہے ہیں تو HTTPS + firewall قواعد فعال کریں۔

## خرابیوں کا ازالہ

- اگر typing/read ایونٹس کام کرنا بند کر دیں تو BlueBubbles webhook لاگز چیک کریں اور تصدیق کریں کہ gateway پاتھ `channels.bluebubbles.webhookPath` سے میل کھاتا ہے۔
- Pairing codes ایک گھنٹے بعد ختم ہو جاتے ہیں؛ `openclaw pairing list bluebubbles` اور `openclaw pairing approve bluebubbles <code>` استعمال کریں۔
- ری ایکشنز کے لیے BlueBubbles private API درکار ہے (`POST /api/v1/message/react`)؛ یقینی بنائیں کہ سرور ورژن اسے فراہم کرتا ہے۔
- Edit/unsend require macOS 13+ and a compatible BlueBubbles server version. On macOS 26 (Tahoe), edit is currently broken due to private API changes.
- macOS 26 (Tahoe) پر گروپ آئیکن اپڈیٹس غیر مستحکم ہو سکتی ہیں: API کامیابی لوٹا سکتی ہے مگر نیا آئیکن sync نہیں ہوتا۔
- OpenClaw auto-hides known-broken actions based on the BlueBubbles server's macOS version. If edit still appears on macOS 26 (Tahoe), disable it manually with `channels.bluebubbles.actions.edit=false`.
- اسٹیٹس/ہیلتھ معلومات کے لیے: `openclaw status --all` یا `openclaw status --deep`۔

عمومی چینل ورک فلو کے حوالے کے لیے [Channels](/channels) اور [Plugins](/tools/plugin) گائیڈ دیکھیں۔
