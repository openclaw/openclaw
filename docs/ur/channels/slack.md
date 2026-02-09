---
summary: "Socket یا HTTP webhook موڈ کے لیے Slack سیٹ اپ"
read_when: "Slack سیٹ اپ کرتے وقت یا Slack socket/HTTP موڈ کی ڈیبگنگ کے دوران"
title: "Slack"
---

# Slack

## Socket موڈ (بطورِ طے شدہ)

### فوری سیٹ اپ (مبتدی)

1. ایک Slack ایپ بنائیں اور **Socket Mode** فعال کریں۔
2. ایک **App Token** (`xapp-...`) اور **Bot Token** (`xoxb-...`) بنائیں۔
3. OpenClaw کے لیے ٹوکن سیٹ کریں اور Gateway شروع کریں۔

کم از کم کنفیگ:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### سیٹ اپ

1. [https://api.slack.com/apps](https://api.slack.com/apps) پر ایک Slack ایپ بنائیں (From scratch)۔
2. **Socket Mode** → آن کریں۔ پھر **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** پر جائیں اور اسکوپ `connections:write` کے ساتھ ٹوکن بنائیں۔ **App Token** (`xapp-...`) کاپی کریں۔
3. **OAuth & Permissions** → بوٹ ٹوکن اسکوپس شامل کریں (نیچے دیا گیا مینی فیسٹ استعمال کریں)۔ **Install to Workspace** پر کلک کریں۔ **Bot User OAuth Token** (`xoxb-...`) کاپی کریں۔
4. Optional: **OAuth & Permissions** → add **User Token Scopes** (see the read-only list below). ایپ کو دوبارہ انسٹال کریں اور **User OAuth Token** (`xoxp-...`) کاپی کریں۔
5. **Event Subscriptions** → ایونٹس فعال کریں اور درج ذیل کو سبسکرائب کریں:
   - `message.*` (ترمیمات/حذف/تھریڈ براڈکاسٹس شامل ہیں)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. بوٹ کو اُن چینلز میں مدعو کریں جنہیں آپ پڑھوانا چاہتے ہیں۔
7. Slash Commands → اگر آپ `channels.slack.slashCommand` استعمال کرتے ہیں تو `/openclaw` بنائیں۔ اگر آپ نیٹو کمانڈز فعال کرتے ہیں تو ہر بلٹ اِن کمانڈ کے لیے ایک سلیش کمانڈ شامل کریں (وہی نام جو `/help` میں ہیں)۔ Slack کے لیے نیٹو ڈیفالٹ آف ہوتا ہے جب تک آپ `channels.slack.commands.native: true` سیٹ نہ کریں (گلوبل `commands.native` کی ویلیو `"auto"` ہے جو Slack کو آف ہی چھوڑتی ہے)۔
8. App Home → **Messages Tab** فعال کریں تاکہ صارفین بوٹ کو DM کر سکیں۔

اسکوپس اور ایونٹس کو ہم آہنگ رکھنے کے لیے نیچے دیا گیا مینی فیسٹ استعمال کریں۔

ملٹی اکاؤنٹ سپورٹ: ہر اکاؤنٹ کے ٹوکنز کے ساتھ `channels.slack.accounts` استعمال کریں اور اختیاری `name` شامل کریں۔ مشترکہ پیٹرن کے لیے [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) دیکھیں۔

### OpenClaw کنفیگ (Socket موڈ)

env vars کے ذریعے ٹوکن سیٹ کریں (سفارش کردہ):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

یا کنفیگ کے ذریعے:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### User token (اختیاری)

OpenClaw ریڈ آپریشنز کے لیے Slack یوزر ٹوکن (`xoxp-...`) استعمال کر سکتا ہے (ہسٹری، پنز، ری ایکشنز، ایموجی، ممبر معلومات)۔ ڈیفالٹ طور پر یہ ریڈ اونلی رہتا ہے: ریڈز موجود ہونے پر یوزر ٹوکن کو ترجیح دیتے ہیں، اور رائٹس اب بھی بوٹ ٹوکن سے ہوتے ہیں جب تک آپ واضح طور پر آپٹ اِن نہ کریں۔ Even with `userTokenReadOnly: false`, the bot token stays
preferred for writes when it is available.

یوزر ٹوکنز کنفیگ فائل میں سیٹ کیے جاتے ہیں (env var سپورٹ نہیں)۔ ملٹی اکاؤنٹ کے لیے، `channels.slack.accounts.<id>` سیٹ کریں۔.userToken\`.

بوٹ + ایپ + یوزر ٹوکنز کے ساتھ مثال:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

userTokenReadOnly کو واضح طور پر سیٹ کرنے کی مثال (user token لکھائیاں اجازت دیں):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### ٹوکن کا استعمال

- پڑھنے کی کارروائیاں (ہسٹری، ری ایکشنز فہرست، پن فہرست، ایموجی فہرست، ممبر معلومات،
  سرچ) کنفیگر ہونے پر user token کو ترجیح دیتی ہیں، ورنہ بوٹ ٹوکن۔
- رائٹ آپریشنز (میسجز بھیجنا/ایڈٹ/ڈیلیٹ، ری ایکشنز شامل/ہٹانا، پن/اَن پن، فائل اپلوڈز) ڈیفالٹ طور پر بوٹ ٹوکن استعمال کرتے ہیں۔ If `userTokenReadOnly: false` and
  no bot token is available, OpenClaw falls back to the user token.

### History سیاق

- `channels.slack.historyLimit` (یا `channels.slack.accounts.*.historyLimit`) اس بات کو کنٹرول کرتا ہے کہ حالیہ کتنے چینل/گروپ پیغامات پرامپٹ میں شامل ہوں۔
- `messages.groupChat.historyLimit` پر فال بیک ہوتا ہے۔ غیر فعال کرنے کے لیے `0` سیٹ کریں (ڈیفالٹ 50)۔

## HTTP موڈ (Events API)

جب آپ کا گیٹ وے Slack کے لیے HTTPS پر قابلِ رسائی ہو تو HTTP ویب ہُک موڈ استعمال کریں (عموماً سرور ڈپلائمنٹس کے لیے)۔
HTTP موڈ Events API + Interactivity + Slash Commands کو ایک مشترکہ ریکویسٹ URL کے ساتھ استعمال کرتا ہے۔

### سیٹ اپ (HTTP موڈ)

1. ایک Slack ایپ بنائیں اور **Socket Mode** غیر فعال کریں (اگر آپ صرف HTTP استعمال کرتے ہیں تو اختیاری)۔
2. **Basic Information** → **Signing Secret** کاپی کریں۔
3. **OAuth & Permissions** → ایپ انسٹال کریں اور **Bot User OAuth Token** (`xoxb-...`) کاپی کریں۔
4. **Event Subscriptions** → ایونٹس فعال کریں اور **Request URL** کو اپنے Gateway webhook راستے پر سیٹ کریں (بطورِ طے شدہ `/slack/events`)۔
5. **Interactivity & Shortcuts** → فعال کریں اور وہی **Request URL** سیٹ کریں۔
6. **Slash Commands** → اپنے کمانڈ(ز) کے لیے وہی **Request URL** سیٹ کریں۔

ریکویسٹ URL کی مثال:
`https://gateway-host/slack/events`

### OpenClaw کنفیگ (کم از کم)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

ملٹی اکاؤنٹ HTTP موڈ: `channels.slack.accounts.<id>` سیٹ کریں۔.mode = "http"`اور ہر اکاؤنٹ کے لیے ایک منفرد`webhookPath\` فراہم کریں تاکہ ہر Slack ایپ اپنی الگ URL پر پوائنٹ کر سکے۔

### مینی فیسٹ (اختیاری)

ایپ جلدی بنانے کے لیے اس Slack ایپ مینی فیسٹ کا استعمال کریں (اگر چاہیں تو نام/کمانڈ ایڈجسٹ کریں)۔ اگر آپ یوزر ٹوکن کنفیگر کرنے کا ارادہ رکھتے ہیں تو یوزر اسکوپس شامل کریں۔

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

اگر آپ نیٹو کمانڈز فعال کرتے ہیں تو جس ہر کمانڈ کو ایکسپوز کرنا چاہتے ہیں اس کے لیے ایک `slash_commands` انٹری شامل کریں (`/help` کی فہرست کے مطابق)۔ `channels.slack.commands.native` کے ذریعے اووررائیڈ کریں۔

## Scopes (موجودہ بمقابلہ اختیاری)

Slack کی Conversations API ٹائپ-اسکوپڈ ہے: آپ کو صرف انہی کنورسیشن ٹائپس کے اسکوپس درکار ہیں جنہیں آپ واقعی استعمال کرتے ہیں (channels, groups, im, mpim)۔ جائزہ کے لیے [https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) دیکھیں۔

### بوٹ ٹوکن اسکوپس (لازم)

- `chat:write` (`chat.postMessage` کے ذریعے پیغامات بھیجنا/اپ ڈیٹ/حذف)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (یوزر DMs کے لیے `conversations.open` کے ذریعے DMs کھولنا)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (یوزر تلاش)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (`files.uploadV2` کے ذریعے اپ لوڈز)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### یوزر ٹوکن اسکوپس (اختیاری، بطورِ طے شدہ read-only)

اگر آپ `channels.slack.userToken` کنفیگر کرتے ہیں تو انہیں **User Token Scopes** کے تحت شامل کریں۔

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### آج درکار نہیں (لیکن ممکنہ مستقبل)

- `mpim:write` (صرف تب اگر ہم `conversations.open` کے ذریعے group-DM کھولنا/DM شروع کرنا شامل کریں)
- `groups:write` (صرف تب اگر ہم نجی چینل مینجمنٹ شامل کریں: بنانا/نام بدلنا/مدعو کرنا/آرکائیو)
- `chat:write.public` (صرف تب اگر ہم اُن چینلز میں پوسٹ کرنا چاہیں جن میں بوٹ شامل نہیں)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (صرف تب اگر ہمیں `users.info` سے ای میل فیلڈز درکار ہوں)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (صرف تب اگر ہم فائل میٹاڈیٹا کی فہرست/مطالعہ شروع کریں)

## کنفیگ

Slack صرف Socket Mode استعمال کرتا ہے (کوئی HTTP ویب ہُک سرور نہیں)۔ دونوں ٹوکن فراہم کریں:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

ٹوکن env vars کے ذریعے بھی فراہم کیے جا سکتے ہیں:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Ack ری ایکشنز کو گلوبلی `messages.ackReaction` + `messages.ackReactionScope` کے ذریعے کنٹرول کیا جاتا ہے۔ Use `messages.removeAckAfterReply` to clear the
ack reaction after the bot replies.

## حدود

- آؤٹ باؤنڈ متن کو `channels.slack.textChunkLimit` تک ٹکڑوں میں تقسیم کیا جاتا ہے (بطورِ طے شدہ 4000)۔
- اختیاری نیولائن چنکنگ: لمبائی کے حساب سے تقسیم سے پہلے خالی سطروں (پیراگراف حدود) پر تقسیم کرنے کے لیے `channels.slack.chunkMode="newline"` سیٹ کریں۔
- میڈیا اپ لوڈز `channels.slack.mediaMaxMb` سے محدود ہیں (بطورِ طے شدہ 20)۔

## جواب کی تھریڈنگ

ڈیفالٹ طور پر، OpenClaw مین چینل میں جواب دیتا ہے۔ خودکار تھریڈنگ کو کنٹرول کرنے کے لیے `channels.slack.replyToMode` استعمال کریں:

| موڈ     | رویّہ                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **ڈیفالٹ۔** مین چینل میں جواب دیں۔ صرف اس صورت میں تھریڈ کریں جب ٹرگر کرنے والا پیغام پہلے ہی کسی تھریڈ میں ہو۔                                                                    |
| `first` | پہلا جواب تھریڈ میں جاتا ہے (ٹرگر کرنے والے پیغام کے نیچے)، بعد کے جوابات مین چینل میں جاتے ہیں۔ کانٹیکسٹ کو واضح رکھتے ہوئے تھریڈ کی بھیڑ سے بچنے کے لیے مفید۔ |
| `all`   | تمام جوابات تھریڈ میں جائیں۔ گفتگو کو محدود رکھتا ہے مگر ویژیبِلٹی کم ہو سکتی ہے۔                                                                                                  |

یہ موڈ خودکار جوابات اور ایجنٹ ٹول کالز (`slack sendMessage`) دونوں پر لاگو ہوتا ہے۔

### فی چیٹ-ٹائپ تھریڈنگ

`channels.slack.replyToModeByChatType` سیٹ کر کے ہر چیٹ ٹائپ کے لیے مختلف تھریڈنگ رویّہ کنفیگر کیا جا سکتا ہے:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

سپورٹڈ چیٹ ٹائپس:

- `direct`: 1:1 DMs (Slack `im`)
- `group`: گروپ DMs / MPIMs (Slack `mpim`)
- `channel`: معیاری چینلز (عوامی/نجی)

ترجیحی ترتیب:

1. \`replyToModeByChatType.<chatType>\`\`
2. `replyToMode`
3. فراہم کنندہ کا ڈیفالٹ (`off`)

Legacy `channels.slack.dm.replyToMode` اب بھی بطورِ فالبیک قبول کیا جاتا ہے جب `direct` کے لیے کوئی چیٹ-ٹائپ اوور رائیڈ سیٹ نہ ہو۔

مثالیں:

صرف DMs کو تھریڈ کریں:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

گروپ DMs تھریڈ کریں مگر چینلز کو روٹ میں رکھیں:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

چینلز کو تھریڈ بنائیں، DMs کو روٹ میں رکھیں:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### دستی تھریڈنگ ٹیگز

باریک کنٹرول کے لیے، ایجنٹ کے جوابات میں یہ ٹیگز استعمال کریں:

- `[[reply_to_current]]` — محرک پیغام پر جواب دیں (تھریڈ شروع/جاری کریں)۔
- `[[reply_to:<id>]]` — کسی مخصوص پیغام آئی ڈی پر جواب دیں۔

## سیشنز + روٹنگ

- DMs ایک ہی `main` سیشن شیئر کرتے ہیں (WhatsApp/Telegram کی طرح)۔
- چینلز `agent:<agentId>:slack:channel:<channelId>` سیشنز پر میپ ہوتے ہیں۔
- Slash commands `agent:<agentId>:slack:slash:<userId>` سیشنز استعمال کرتے ہیں (پریفکس `channels.slack.slashCommand.sessionPrefix` کے ذریعے کنفیگر ایبل)۔
- اگر Slack `channel_type` فراہم نہ کرے تو OpenClaw چینل آئی ڈی پریفکس (`D`, `C`, `G`) سے اندازہ لگاتا ہے اور سیشن کیز کو مستحکم رکھنے کے لیے بطورِ طے شدہ `channel` اختیار کرتا ہے۔
- نیٹو کمانڈ رجسٹریشن `commands.native` استعمال کرتی ہے (گلوبل ڈیفالٹ `"auto"` → Slack آف) اور اسے فی ورک اسپیس `channels.slack.commands.native` کے ذریعے اووررائیڈ کیا جا سکتا ہے۔ Text commands require standalone `/...` messages and can be disabled with `commands.text: false`. Slack slash commands are managed in the Slack app and are not removed automatically. Use `commands.useAccessGroups: false` to bypass access-group checks for commands.
- مکمل کمانڈ فہرست + کنفیگ: [Slash commands](/tools/slash-commands)

## DM سکیورٹی (جوڑی بنانا)

- ڈیفالٹ: `channels.slack.dm.policy="pairing"` — نامعلوم DM بھیجنے والوں کو ایک pairing کوڈ ملتا ہے (1 گھنٹے بعد منقضی)۔
- منظوری بذریعہ: `openclaw pairing approve slack <code>`۔
- سب کو اجازت دینے کے لیے: `channels.slack.dm.policy="open"` اور `channels.slack.dm.allowFrom=["*"]` سیٹ کریں۔
- `channels.slack.dm.allowFrom` accepts user IDs, @handles, or emails (resolved at startup when tokens allow). The wizard accepts usernames and resolves them to ids during setup when tokens allow.

## گروپ پالیسی

- `channels.slack.groupPolicy` چینل ہینڈلنگ (`open|disabled|allowlist`) کو کنٹرول کرتا ہے۔
- `allowlist` کے لیے چینلز کا `channels.slack.channels` میں درج ہونا لازم ہے۔
- If you only set `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` and never create a `channels.slack` section,
  the runtime defaults `groupPolicy` to `open`. Add `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy`, or a channel allowlist to lock it down.
- کنفیگر وِزرد `#channel` نام قبول کرتا ہے اور جہاں ممکن ہو انہیں آئی ڈیز میں حل کرتا ہے
  (عوامی + نجی)؛ اگر متعدد میچ ہوں تو فعال چینل کو ترجیح دیتا ہے۔
- اسٹارٹ اپ پر، OpenClaw allowlists میں چینل/یوزر ناموں کو آئی ڈیز میں حل کرتا ہے (جب ٹوکن اجازت دیں)
  اور میپنگ لاگ کرتا ہے؛ غیر حل شدہ اندراجات جیسے ٹائپ کیے گئے ہوں ویسے ہی رکھے جاتے ہیں۔
- **کوئی چینلز** اجازت دینے کے لیے، `channels.slack.groupPolicy: "disabled"` سیٹ کریں (یا خالی allowlist رکھیں)۔

Channel options (`channels.slack.channels.<id>` or `channels.slack.channels.<name>`):

- `allow`: جب `groupPolicy="allowlist"` ہو تو چینل کو اجازت/انکار۔
- `requireMention`: چینل کے لیے مینشن گیٹنگ۔
- `tools`: اختیاری فی چینل ٹول پالیسی اوور رائیڈز (`allow`/`deny`/`alsoAllow`)۔
- `toolsBySender`: چینل کے اندر اختیاری فی بھیجنے والے ٹول پالیسی اوور رائیڈز (کلیدیں بھیجنے والے آئی ڈیز/@ہینڈلز/ای میلز؛ `"*"` وائلڈ کارڈ سپورٹ)۔
- `allowBots`: اس چینل میں بوٹ کے تحریر کردہ پیغامات کی اجازت دیں (ڈیفالٹ: false)۔
- `users`: اختیاری فی چینل یوزر allowlist۔
- `skills`: skill فلٹر (چھوڑ دیں = تمام skills، خالی = کوئی نہیں)۔
- `systemPrompt`: چینل کے لیے اضافی سسٹم پرامپٹ (موضوع/مقصد کے ساتھ ملا کر)۔
- `enabled`: چینل غیر فعال کرنے کے لیے `false` سیٹ کریں۔

## ترسیل کے اہداف

cron/CLI بھیجنے کے ساتھ ان کا استعمال کریں:

- DMs کے لیے `user:<id>`
- چینلز کے لیے `channel:<id>`

## ٹول ایکشنز

Slack ٹول ایکشنز کو `channels.slack.actions.*` کے ذریعے گیٹ کیا جا سکتا ہے:

| ایکشن گروپ | ڈیفالٹ  | نوٹس                         |
| ---------- | ------- | ---------------------------- |
| reactions  | enabled | ری ایکٹ + ری ایکشنز کی فہرست |
| messages   | enabled | پڑھنا/بھیجنا/ترمیم/حذف       |
| pins       | enabled | پن/ان پن/فہرست               |
| memberInfo | enabled | ممبر معلومات                 |
| emojiList  | enabled | کسٹم ایموجی فہرست            |

## سکیورٹی نوٹس

- لکھائیاں بطورِ طے شدہ بوٹ ٹوکن استعمال کرتی ہیں تاکہ حالت بدلنے والی کارروائیاں
  ایپ کے بوٹ کی اجازتوں اور شناخت تک محدود رہیں۔
- Setting `userTokenReadOnly: false` allows the user token to be used for write
  operations when a bot token is unavailable, which means actions run with the
  installing user's access. Treat the user token as highly privileged and keep
  action gates and allowlists tight.
- اگر آپ یوزر-ٹوکن لکھائیاں فعال کرتے ہیں تو یقینی بنائیں کہ یوزر ٹوکن میں مطلوبہ
  لکھنے کے اسکوپس شامل ہوں (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`) ورنہ وہ کارروائیاں ناکام ہوں گی۔

## خرابیوں کا ازالہ

سب سے پہلے یہ کمانڈ سیڑھی چلائیں:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

پھر ضرورت ہو تو DM pairing اسٹیٹ کی تصدیق کریں:

```bash
openclaw pairing list slack
```

عام ناکامیاں:

- کنیکٹڈ ہے مگر چینل جوابات نہیں: چینل `groupPolicy` کے ذریعے بلاک ہے یا `channels.slack.channels` allowlist میں نہیں۔
- DMs نظر انداز: جب `channels.slack.dm.policy="pairing"` ہو تو بھیجنے والا منظور شدہ نہیں۔
- API غلطیاں (`missing_scope`, `not_in_channel`, auth ناکامیاں): بوٹ/ایپ ٹوکن یا Slack اسکوپس نامکمل ہیں۔

ٹرائیج فلو کے لیے: [/channels/troubleshooting](/channels/troubleshooting)۔

## نوٹس

- مینشن گیٹنگ `channels.slack.channels` کے ذریعے کنٹرول ہوتی ہے (`requireMention` کو `true` پر سیٹ کریں)؛ `agents.list[].groupChat.mentionPatterns` (یا `messages.groupChat.mentionPatterns`) بھی مینشن شمار ہوتے ہیں۔
- ملٹی ایجنٹ اوور رائیڈ: `agents.list[].groupChat.mentionPatterns` پر فی ایجنٹ پیٹرنز سیٹ کریں۔
- ری ایکشن نوٹیفکیشنز `channels.slack.reactionNotifications` کے مطابق ہوتی ہیں (موڈ `allowlist` کے ساتھ `reactionAllowlist` استعمال کریں)۔
- Bot-authored messages are ignored by default; enable via `channels.slack.allowBots` or `channels.slack.channels.<id>.allowBots`.
- Warning: If you allow replies to other bots (`channels.slack.allowBots=true` or `channels.slack.channels.<id>.allowBots=true`), prevent bot-to-bot reply loops with `requireMention`, `channels.slack.channels.<id>.users` allowlists, and/or clear guardrails in `AGENTS.md` and `SOUL.md`.
- Slack ٹول کے لیے، ری ایکشن ہٹانے کی معنویت [/tools/reactions](/tools/reactions) میں ہے۔
- اٹیچمنٹس اجازت ملنے اور سائز حد کے اندر ہونے پر میڈیا اسٹور میں ڈاؤن لوڈ کی جاتی ہیں۔
