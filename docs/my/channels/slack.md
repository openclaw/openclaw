---
summary: "Socket သို့မဟုတ် HTTP webhook မုဒ်အတွက် Slack တပ်ဆင်မှု"
read_when: "Slack ကို တပ်ဆင်နေစဉ် သို့မဟုတ် Slack socket/HTTP မုဒ်ကို ပြဿနာရှာဖွေနေစဉ်"
title: "Slack"
---

# Slack

## Socket မုဒ် (ပုံမှန်)

### အမြန်တပ်ဆင်ခြင်း (အစပြုသူများ)

1. Slack app တစ်ခု ဖန်တီးပြီး **Socket Mode** ကို ဖွင့်ပါ။
2. **App Token** (`xapp-...`) နှင့် **Bot Token** (`xoxb-...`) ကို ဖန်တီးပါ။
3. OpenClaw အတွက် token များကို သတ်မှတ်ပြီး gateway ကို စတင်ပါ။

အနည်းဆုံး config:

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

### တပ်ဆင်ခြင်း

1. [https://api.slack.com/apps](https://api.slack.com/apps) တွင် Slack app တစ်ခု (From scratch) ဖန်တီးပါ။
2. **App Token** (`xapp-...`) ကို ကူးယူပါ။ **OAuth & Permissions** → bot token scopes များကို ထည့်ပါ (အောက်ပါ manifest ကို အသုံးပြုပါ)။ **Install to Workspace** ကို နှိပ်ပါ။
3. **Bot User OAuth Token** (`xoxb-...`) ကို ကူးယူပါ။ မဖြစ်မနေ မဟုတ်ပါ: **OAuth & Permissions** → **User Token Scopes** ကို ထည့်ပါ (အောက်ပါ read-only စာရင်းကို ကြည့်ပါ)။ App ကို ပြန်လည် install လုပ်ပြီး **User OAuth Token** (`xoxp-...`) ကို ကူးယူပါ။
4. Slash Commands → `channels.slack.slashCommand` ကို အသုံးပြုပါက `/openclaw` ကို ဖန်တီးပါ။ Native commands ကို ဖွင့်ထားပါက built-in command တစ်ခုစီအတွက် slash command တစ်ခုစီကို ထည့်ပါ (`/help` နှင့် အမည်တူ)။
5. **Event Subscriptions** → events ကို ဖွင့်ပြီး အောက်ပါများကို subscribe လုပ်ပါ။
   - `message.*` (edit/delete/thread broadcast များ ပါဝင်)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. ဖတ်ရှုစေလိုသော ချန်နယ်များသို့ bot ကို ဖိတ်ကြားပါ။
7. Slack အတွက် Native သည် ပုံမှန်အားဖြင့် ပိတ်ထားပြီး `channels.slack.commands.native: true` ကို သတ်မှတ်မှသာ ဖွင့်ပါမည် (global `commands.native` သည် `"auto"` ဖြစ်ပြီး Slack ကို ပိတ်ထားစေပါသည်)။ ပုံစံတူ အသုံးပြုနည်းအတွက် [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) ကို ကြည့်ပါ။ OpenClaw သည် Slack user token (`xoxp-...`) ကို ဖတ်ရှုမှုလုပ်ငန်းများ (history,
   pins, reactions, emoji, member info) အတွက် အသုံးပြုနိုင်ပါသည်။
8. **App Home** → **Messages Tab** ကို ဖွင့်ပြီး အသုံးပြုသူများ bot ကို DM ပို့နိုင်စေရန် ပြုလုပ်ပါ။

scope များနှင့် events များ တစ်ပြိုင်နက်တည်း ဖြစ်စေရန် အောက်ပါ manifest ကို အသုံးပြုပါ။

Multi-account ပံ့ပိုးမှု: per-account token များနှင့် optional `name` ကို အသုံးပြု၍ `channels.slack.accounts` ကို အသုံးပြုပါ။ ပုံမှန်အားဖြင့် ၎င်းသည် read-only အဖြစ် ဆက်လက်ရှိနေပါသည်: reads များသည် user token ရှိပါက ၎င်းကို ဦးစားပေးအသုံးပြုပြီး writes များသည် သင်က အထူးအနေဖြင့် မရွေးချယ်ပါက bot token ကိုသာ အသုံးပြုပါသည်။

### OpenClaw config (Socket မုဒ်)

env vars ဖြင့် token များ သတ်မှတ်ပါ (အကြံပြု):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

သို့မဟုတ် config ဖြင့်:

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

### User token (ရွေးချယ်စရာ)

`userTokenReadOnly: false` ဖြစ်နေသော်လည်း bot token ရရှိနိုင်ပါက writes များအတွက် bot token ကို ဦးစားပေးနေဆဲဖြစ်ပါသည်။ User token များကို config ဖိုင်တွင် သတ်မှတ်ရပါသည် (env var ပံ့ပိုးမှု မရှိပါ)။ Multi-account အတွက် `channels.slack.accounts.<id>
.userToken` ကို သတ်မှတ်ပါ။

Write လုပ်ငန်းများ (မက်ဆေ့ချ် ပို့/ပြင်/ဖျက်၊ reaction ထည့်/ဖယ်၊ pin/unpin,
ဖိုင်တင်ခြင်း) သည် ပုံမှန်အားဖြင့် bot token ကို အသုံးပြုပါသည်။ `userTokenReadOnly: false` ဖြစ်ပြီး bot token မရှိပါက OpenClaw သည် user token သို့ ပြန်လည်အသုံးပြုပါသည်။.userToken\`.

bot + app + user token များပါသော ဥပမာ:

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

userTokenReadOnly ကို အထူးသတ်မှတ်ထားသော ဥပမာ (user token ရေးသားခွင့် ပေးခြင်း):

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

#### Token အသုံးပြုမှု

- ဖတ်ရှုရေးရာ လုပ်ဆောင်ချက်များ (history, reactions list, pins list, emoji list, member info,
  search) သည် user token ရှိပါက ဦးစားပေးပြီး မရှိပါက bot token ကို အသုံးပြုပါသည်။
- Write operations (send/edit/delete messages, add/remove reactions, pin/unpin,
  file uploads) use the bot token by default. If `userTokenReadOnly: false` and
  no bot token is available, OpenClaw falls back to the user token.

### History context

- `channels.slack.historyLimit` (သို့မဟုတ် `channels.slack.accounts.*.historyLimit`) သည် prompt ထဲသို့ ထည့်သွင်းမည့် ချန်နယ်/အုပ်စု မက်ဆေ့ချ် အရေအတွက်ကို ထိန်းချုပ်ပါသည်။
- `messages.groupChat.historyLimit` ကို fallback အဖြစ် အသုံးပြုသည်။ ပိတ်ရန် `0` ကို သတ်မှတ်ပါ (မူလတန်ဖိုး 50)။

## HTTP မုဒ် (Events API)

သင့် Gateway ကို Slack က HTTPS ဖြင့် ချိတ်ဆက်နိုင်သောအခါ HTTP webhook mode ကို အသုံးပြုပါ (ပုံမှန်အားဖြင့် server deployment များအတွက်)။
HTTP mode သည် Events API + Interactivity + Slash Commands ကို shared request URL တစ်ခုဖြင့် အသုံးပြုသည်။

### တပ်ဆင်ခြင်း (HTTP မုဒ်)

1. Slack app တစ်ခု ဖန်တီးပြီး **Socket Mode** ကို ပိတ်ပါ (HTTP ကိုသာ အသုံးပြုပါက ရွေးချယ်စရာ)။
2. **Basic Information** → **Signing Secret** ကို ကူးယူပါ။
3. **OAuth & Permissions** → app ကို install လုပ်ပြီး **Bot User OAuth Token** (`xoxb-...`) ကို ကူးယူပါ။
4. **Event Subscriptions** → events ကို ဖွင့်ပြီး **Request URL** ကို သင်၏ gateway webhook လမ်းကြောင်းသို့ သတ်မှတ်ပါ (ပုံမှန် `/slack/events`)။
5. **Interactivity & Shortcuts** → ဖွင့်ပြီး အတူတူသော **Request URL** ကို သတ်မှတ်ပါ။
6. **Slash Commands** → သင်၏ command များအတွက် အတူတူသော **Request URL** ကို သတ်မှတ်ပါ။

Request URL ဥပမာ:
`https://gateway-host/slack/events`

### OpenClaw config (အနည်းဆုံး)

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

Multi-account HTTP mode: `channels.slack.accounts.<id>` ကို သတ်မှတ်ပါ.mode = "http"\` ဟု သတ်မှတ်ပြီး account တစ်ခုချင်းစီအတွက် ထူးခြားသော

### Manifest (ရွေးချယ်စရာ)

`webhookPath` ကို ပေးပါ၊ Slack app တစ်ခုချင်းစီက ကိုယ်ပိုင် URL ကို ညွှန်းနိုင်စေရန်။ ဒီ Slack app manifest ကို အသုံးပြုပြီး app ကို မြန်မြန် ဖန်တီးပါ (အမည်/command ကို လိုအပ်သလို ပြင်ဆင်နိုင်သည်)။

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

user token ကို ပြင်ဆင်သတ်မှတ်ရန် စီစဉ်ထားပါက user scopes များကို ထည့်သွင်းပါ။ native commands ကို ဖွင့်ထားပါက ဖော်ပြလိုသော command တစ်ခုချင်းစီအတွက် `slash_commands` entry တစ်ခုစီ ထည့်ပါ (`/help` စာရင်းနှင့် ကိုက်ညီရပါမည်)။

## Scopes (လက်ရှိ vs ရွေးချယ်စရာ)

`channels.slack.commands.native` ဖြင့် override လုပ်နိုင်သည်။ Slack ၏ Conversations API သည် type အလိုက် scope ခွဲထားသည် — သင် တကယ် အသုံးပြုမည့် conversation type များ (channels, groups, im, mpim) အတွက်သာ scopes လိုအပ်ပါသည်။

### Bot token scopes (လိုအပ်သည်)

- `chat:write` (`chat.postMessage` ဖြင့် မက်ဆေ့ချ် ပို့/ပြင်/ဖျက်)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (user DM များအတွက် `conversations.open` ဖြင့် DM ဖွင့်ခြင်း)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (user lookup)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (`files.uploadV2` ဖြင့် upload)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### User token scopes (ရွေးချယ်စရာ၊ ပုံမှန် read-only)

`channels.slack.userToken` ကို ပြင်ဆင်သတ်မှတ်ပါက **User Token Scopes** အောက်တွင် အောက်ပါများကို ထည့်ပါ။

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### ယနေ့မလိုအပ်သေးသော်လည်း (နောင်တွင် ဖြစ်နိုင်)

- `mpim:write` (`conversations.open` ဖြင့် group-DM ဖွင့်ခြင်း/DM စတင်ခြင်း ထည့်ပါကသာ)
- `groups:write` (private-channel စီမံခန့်ခွဲမှု: create/rename/invite/archive ထည့်ပါကသာ)
- `chat:write.public` (bot မပါဝင်သော ချန်နယ်များသို့ ပို့လိုပါက)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (`users.info` မှ email field များ လိုအပ်ပါက)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (ဖိုင် metadata များကို စာရင်းပြုစု/ဖတ်ရန် စတင်ပါက)

## Config

အကျဉ်းချုပ်အတွက် ကြည့်ပါ
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) ။ Slack သည် Socket Mode ကိုသာ အသုံးပြုသည် (HTTP webhook server မရှိပါ)။

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

token များကို env vars ဖြင့်လည်း ပေးနိုင်ပါသည်။

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

token နှစ်ခုစလုံးကို ပေးပါ: Ack reactions များကို `messages.ackReaction` +
`messages.ackReactionScope` ဖြင့် global အဆင့်တွင် ထိန်းချုပ်သည်။

## ကန့်သတ်ချက်များ

- အပြင်ပို့ text များကို `channels.slack.textChunkLimit` အထိ ခွဲထုတ်ပို့ပါသည် (ပုံမှန် 4000)။
- newline ဖြင့် ခွဲထုတ်ခြင်း (ရွေးချယ်စရာ): အရှည်အလိုက် ခွဲထုတ်မီ စာပိုဒ်အလိုက် ခွဲရန် `channels.slack.chunkMode="newline"` ကို သတ်မှတ်ပါ။
- Media upload များကို `channels.slack.mediaMaxMb` ဖြင့် ကန့်သတ်ထားပါသည် (ပုံမှန် 20)။

## Reply threading

bot က ပြန်ကြားပြီးနောက် ack reaction ကို ဖယ်ရှားရန် `messages.removeAckAfterReply` ကို အသုံးပြုပါ။ မူလအနေဖြင့် OpenClaw သည် main channel တွင် ပြန်ကြားသည်။

| Mode    | Behavior                                                                                                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | automatic threading ကို ထိန်းချုပ်ရန် `channels.slack.replyToMode` ကို အသုံးပြုပါ: **မူလတန်ဖိုး။** main channel တွင် ပြန်ကြားသည်။                                                                                             |
| `first` | trigger ဖြစ်စေသော message သည် thread အတွင်းရှိပြီးသားဖြစ်ပါကသာ thread ထဲတွင် ပြန်ကြားသည်။ ပထမဆုံး ပြန်ကြားချက်သည် thread (trigger message အောက်တွင်) သို့ သွားပြီး နောက်ထပ် ပြန်ကြားချက်များသည် main channel သို့ သွားသည်။ |
| `all`   | context ကို မြင်သာစေပြီး thread များ အလွန်များခြင်းကို ရှောင်ရှားရန် အသုံးဝင်သည်။ ပြန်ကြားချက်အားလုံးကို thread ထဲသို့သာ ပို့သည်။                                                                                                             |

ဤ mode သည် auto-replies နှင့် agent tool calls (`slack sendMessage`) နှစ်ခုလုံးအတွက် အသုံးဝင်ပါသည်။

### Chat အမျိုးအစားအလိုက် threading

`channels.slack.replyToModeByChatType` ကို သတ်မှတ်ခြင်းဖြင့် chat အမျိုးအစားတစ်ခုချင်းစီအလိုက် threading behavior ကို သတ်မှတ်နိုင်ပါသည်။

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

ပံ့ပိုးထားသော chat အမျိုးအစားများ:

- `direct`: 1:1 DM များ (Slack `im`)
- `group`: group DM / MPIM များ (Slack `mpim`)
- `channel`: ပုံမှန် ချန်နယ်များ (public/private)

ဦးစားပေးမှု အစီအစဉ်:

1. စကားဝိုင်းများကို ထိန်းသိမ်းထားနိုင်သော်လည်း မြင်သာမှု လျော့နည်းနိုင်သည်။`replyToModeByChatType.<chatType>`
2. `replyToMode`
3. provider ပုံမှန် (`off`)

Legacy `channels.slack.dm.replyToMode` ကို chat-type override မရှိသည့်အခါ `direct` အတွက် fallback အဖြစ် လက်ခံထားဆဲဖြစ်ပါသည်။

ဥပမာများ:

DM များကိုသာ thread လုပ်ခြင်း:

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

Group DM များကို thread လုပ်ပြီး ချန်နယ်များကို root တွင်ထားခြင်း:

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

ချန်နယ်များကို thread လုပ်ပြီး DM များကို root တွင်ထားခြင်း:

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

### Manual threading tags

အသေးစိတ် ထိန်းချုပ်ရန် agent response များအတွင်း အောက်ပါ tag များကို အသုံးပြုပါ။

- `[[reply_to_current]]` — triggering message သို့ ပြန်ကြားခြင်း (thread စတင်/ဆက်လက်)။
- `[[reply_to:<id>]]` — message id တစ်ခုကို သတ်မှတ်ပြီး ပြန်ကြားခြင်း။

## Sessions + routing

- DM များသည် `main` session ကို မျှဝေပါသည် (WhatsApp/Telegram ကဲ့သို့)။
- ချန်နယ်များသည် `agent:<agentId>:slack:channel:<channelId>` session များသို့ ချိတ်ဆက်ပါသည်။
- Slash commands များသည် `agent:<agentId>:slack:slash:<userId>` session များကို အသုံးပြုပါသည် (prefix ကို `channels.slack.slashCommand.sessionPrefix` ဖြင့် ပြင်ဆင်နိုင်)။
- Slack မှ `channel_type` ကို မပေးပါက OpenClaw သည် channel ID prefix (`D`, `C`, `G`) မှ ခန့်မှန်းပြီး session key များ တည်ငြိမ်စေရန် `channel` ကို ပုံမှန်အဖြစ် သတ်မှတ်ပါသည်။
- `Native command registration သည်`commands.native`(global မူလတန်ဖိုး "auto" → Slack ပိတ်ထား) ကို အသုံးပြုပြီး workspace အလိုက်`channels.slack.commands.native`ဖြင့် override လုပ်နိုင်သည်။ Text commands များသည် standalone`/...`message များ လိုအပ်ပြီး`commands.text: false\` ဖြင့် ပိတ်နိုင်သည်။ Slack slash commands များကို Slack app အတွင်းတွင် စီမံခန့်ခွဲရပြီး အလိုအလျောက် ဖယ်ရှားမပေးပါ။
- Command အပြည့်အစုံနှင့် config: [Slash commands](/tools/slash-commands)

## DM လုံခြုံရေး (pairing)

- ပုံမှန်: `channels.slack.dm.policy="pairing"` — မသိသော DM ပို့သူများကို pairing code ပေးပြီး (၁ နာရီအကြာ သက်တမ်းကုန်)။
- အတည်ပြုရန်: `openclaw pairing approve slack <code>` ကို အသုံးပြုပါ။
- လူတိုင်း ခွင့်ပြုရန်: `channels.slack.dm.policy="open"` နှင့် `channels.slack.dm.allowFrom=["*"]` ကို သတ်မှတ်ပါ။
- command များအတွက် access-group စစ်ဆေးမှုကို ကျော်လွှားရန် `commands.useAccessGroups: false` ကို အသုံးပြုပါ။ `channels.slack.dm.allowFrom` သည် user IDs, @handles သို့မဟုတ် emails များကို လက်ခံပြီး (token များ ခွင့်ပြုပါက startup အချိန်တွင် resolve လုပ်သည်)။

## Group policy

- `channels.slack.groupPolicy` သည် ချန်နယ် ကိုင်တွယ်ပုံကို ထိန်းချုပ်ပါသည် (`open|disabled|allowlist`)။
- `allowlist` သည် ချန်နယ်များကို `channels.slack.channels` အတွင်း စာရင်းသွင်းထားရန် လိုအပ်ပါသည်။
- wizard သည် setup အတွင်း usernames များကို လက်ခံပြီး token များ ခွင့်ပြုပါက ids များသို့ resolve လုပ်သည်။ `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` ကိုသာ သတ်မှတ်ပြီး `channels.slack` section ကို မဖန်တီးပါက runtime သည် `groupPolicy` ကို `open` ဟု မူလအနေဖြင့် သတ်မှတ်သည်။
- Configure wizard သည် `#channel` အမည်များကို လက်ခံပြီး ဖြစ်နိုင်ပါက ID များသို့ ပြောင်းလဲပေးပါသည်
  (public + private)။ ကိုက်ညီမှု များစွာရှိပါက active channel ကို ဦးစားပေးပါသည်။
- စတင်ချိန်တွင် OpenClaw သည် allowlist များအတွင်း channel/user အမည်များကို ID များသို့ ပြောင်းလဲပြီး (token များ ခွင့်ပြုပါက)
  mapping ကို log ထုတ်ပြပါသည်။ မဖြေရှင်းနိုင်သော entry များကို မူလအတိုင်း ထားရှိပါသည်။
- **ချန်နယ် မည်သည့်တစ်ခုမျှ မခွင့်ပြုလိုပါက** `channels.slack.groupPolicy: "disabled"` ကို သတ်မှတ်ပါ (သို့မဟုတ် အလွတ် allowlist ကို ထားပါ)။

lock down လုပ်ရန် `channels.slack.groupPolicy`,
`channels.defaults.groupPolicy` သို့မဟုတ် channel allowlist တစ်ခု ထည့်ပါ။Channel options (`channels.slack.channels.<id>`` သို့မဟုတ် `channels.slack.channels.<name>\`

- `allow`: `groupPolicy="allowlist"` ဖြစ်ပါက ချန်နယ်ကို ခွင့်ပြု/ပိတ်။
- `requireMention`: ချန်နယ်အတွက် mention gating။
- `tools`: ချန်နယ်အလိုက် tool policy override များ (`allow`/`deny`/`alsoAllow`)။
- `toolsBySender`: ချန်နယ်အတွင်း ပို့သူအလိုက် tool policy override များ (key များမှာ sender id/@handle/email; `"*"` wildcard ပံ့ပိုး)။
- `allowBots`: ဤချန်နယ်တွင် bot ရေးသားသော မက်ဆေ့ချ်များကို ခွင့်ပြုခြင်း (ပုံမှန်: false)။
- `users`: ချန်နယ်အလိုက် user allowlist (ရွေးချယ်စရာ)။
- `skills`: skill filter (မရေးပါက = Skills အားလုံး, အလွတ် = မည်သည့် Skill မဆို မရှိ)။
- `systemPrompt`: ချန်နယ်အတွက် ထပ်ဆောင်း system prompt (topic/purpose နှင့် ပေါင်းစပ်)။
- `enabled`: ချန်နယ်ကို ပိတ်ရန် `false` ကို သတ်မှတ်ပါ။

## Delivery targets

cron/CLI ပို့ရန်များနှင့်အတူ အောက်ပါများကို အသုံးပြုပါ။

- DM များအတွက် `user:<id>`
- ချန်နယ်များအတွက် `channel:<id>`

## Tool actions

Slack tool actions များကို `channels.slack.actions.*` ဖြင့် gating လုပ်နိုင်ပါသည်။

| Action group | Default | Notes                  |
| ------------ | ------- | ---------------------- |
| reactions    | enabled | React + list reactions |
| messages     | enabled | Read/send/edit/delete  |
| pins         | enabled | Pin/unpin/list         |
| memberInfo   | enabled | Member info            |
| emojiList    | enabled | Custom emoji list      |

## လုံခြုံရေး မှတ်ချက်များ

- ရေးသားရေးရာ လုပ်ဆောင်ချက်များကို ပုံမှန်အားဖြင့် bot token ဖြင့်သာ လုပ်ဆောင်ပြီး state ပြောင်းလဲမှုများကို app ၏ bot permission နှင့် identity အတွင်း ထိန်းသိမ်းထားပါသည်။
- Setting `userTokenReadOnly: false` allows the user token to be used for write
  operations when a bot token is unavailable, which means actions run with the
  installing user's access. `userTokenReadOnly: false` ကို သတ်မှတ်ပါက bot token မရရှိနိုင်သည့်အခါ user token ကို write operations များအတွက် အသုံးပြုခွင့်ပေးပြီး လုပ်ဆောင်ချက်များသည် installing user ၏ access ဖြင့် လည်ပတ်မည်ဖြစ်သည်။
- user-token writes ကို ဖွင့်ပါက user token တွင် မျှော်လင့်ထားသော write scopes (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`) ပါဝင်ကြောင်း သေချာစေရန်၊ မပါဝင်ပါက အဆိုပါ လုပ်ဆောင်ချက်များ မအောင်မြင်ပါ။

## Troubleshooting

အရင်ဆုံး အောက်ပါ ladder ကို လုပ်ဆောင်ပါ။

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

လိုအပ်ပါက DM pairing အခြေအနေကို ထပ်မံ အတည်ပြုပါ။

```bash
openclaw pairing list slack
```

ပုံမှန် တွေ့ရသော ပြဿနာများ:

- ချိတ်ဆက်ပြီးသားဖြစ်သော်လည်း ချန်နယ်တွင် ပြန်ကြားချက် မရှိခြင်း: ချန်နယ်ကို `groupPolicy` ဖြင့် ပိတ်ထားခြင်း သို့မဟုတ် `channels.slack.channels` allowlist ထဲ မပါဝင်ခြင်း။
- DM များကို လျစ်လျူရှုခြင်း: `channels.slack.dm.policy="pairing"` ဖြစ်နေစဉ် ပို့သူကို မအတည်ပြုထားခြင်း။
- API error များ (`missing_scope`, `not_in_channel`, auth မအောင်မြင်ခြင်း): bot/app token များ သို့မဟုတ် Slack scopes မပြည့်စုံခြင်း။

Triage လုပ်ငန်းစဉ်အတွက်: [/channels/troubleshooting](/channels/troubleshooting)။

## Notes

- Mention gating ကို `channels.slack.channels` ဖြင့် ထိန်းချုပ်ပါသည် (`requireMention` ကို `true` ဟု သတ်မှတ်ပါ)။ `agents.list[].groupChat.mentionPatterns` (သို့မဟုတ် `messages.groupChat.mentionPatterns`) ကိုလည်း mention အဖြစ် ရေတွက်ပါသည်။
- Multi-agent override: agent တစ်ခုချင်းစီအလိုက် pattern များကို `agents.list[].groupChat.mentionPatterns` တွင် သတ်မှတ်ပါ။
- Reaction notification များသည် `channels.slack.reactionNotifications` ကို လိုက်နာပါသည် (mode `allowlist` ဖြင့် `reactionAllowlist` ကို အသုံးပြုပါ)။
- user token ကို အလွန်အရေးကြီးသော အခွင့်အာဏာရှိသည့်အရာအဖြစ် သတ်မှတ်ပြီး action gates နှင့် allowlists များကို တင်းကျပ်စွာ ထိန်းသိမ်းပါ။bot မှ ရေးသားထားသော messages များကို မူလအနေဖြင့် မလက်ခံပါ — `channels.slack.allowBots` သို့မဟုတ် `channels.slack.channels.<id>` ဖြင့် ဖွင့်နိုင်သည်။
- .allowBots`.သတိပေးချက်: အခြား bot များထံ ပြန်ကြားမှုကို ခွင့်ပြုပါက (`channels.slack.allowBots=true`သို့မဟုတ်`channels.slack.channels.<id>`.allowBots=true`), `requireMention`, `channels.slack.channels.<id>`
- Slack tool အတွက် reaction ဖယ်ရှားမှု အပြုအမူများကို [/tools/reactions](/tools/reactions) တွင် ဖော်ပြထားပါသည်။
- Attachment များကို ခွင့်ပြုထားပြီး အရွယ်အစားကန့်သတ်ချက်အောက်တွင် ရှိပါက media store သို့ ဒေါင်းလုဒ် ပြုလုပ်ပါသည်။
