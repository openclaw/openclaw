---
summary: "QQ Bot channel plugin setup, config, and usage"
read_when:
  - You want to connect OpenClaw to QQ
  - You need QQ Bot credential setup
  - You want QQ Bot group or private chat support
title: QQ Bot
---

# QQ Bot (plugin)

QQ Bot connects to OpenClaw via the official QQ Bot API (WebSocket gateway). The
plugin supports C2C private chat, group @messages, and guild channel messages with
rich media (images, voice, video, files).

Status: supported via plugin. Direct messages, group chats, guild channels, and
media are supported. Reactions and threads are not supported.

## Plugin required

Install the QQ Bot plugin:

```bash
openclaw plugins install @openclaw/qqbot
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/qqbot
```

## Setup

1. Go to the [QQ Open Platform](https://q.qq.com/) and scan the QR code with your
   phone QQ to register / log in.
2. Click **Create Bot** to create a new QQ bot.
3. Find **AppID** and **AppSecret** on the bot's settings page and copy them.

> AppSecret is not stored in plaintext — if you leave the page without saving it,
> you'll have to regenerate a new one.

4. Add the channel:

```bash
openclaw channels add --channel qqbot --token "AppID:AppSecret"
```

5. Restart the Gateway.

## Configure

Minimal config:

```json5
{
  channels: {
    qqbot: {
      enabled: true,
      appId: "YOUR_APP_ID",
      clientSecret: "YOUR_APP_SECRET",
    },
  },
}
```

### Multi-account setup

Run multiple QQ bots under a single OpenClaw instance:

```json5
{
  channels: {
    qqbot: {
      enabled: true,
      appId: "111111111",
      clientSecret: "secret-of-bot-1",
      accounts: {
        bot2: {
          enabled: true,
          appId: "222222222",
          clientSecret: "secret-of-bot-2",
        },
      },
    },
  },
}
```

Each account launches its own WebSocket connection and maintains an independent
token cache (isolated by `appId`).

Add a second bot via CLI:

```bash
openclaw channels add --channel qqbot --account bot2 --token "222222222:secret-of-bot-2"
```

### Voice (STT / TTS)

STT and TTS support two-level configuration with priority fallback:

| Setting | Plugin-specific      | Framework fallback            |
| ------- | -------------------- | ----------------------------- |
| STT     | `channels.qqbot.stt` | `tools.media.audio.models[0]` |
| TTS     | `channels.qqbot.tts` | `messages.tts`                |

```json5
{
  channels: {
    qqbot: {
      stt: {
        provider: "your-provider",
        model: "your-stt-model",
      },
      tts: {
        provider: "your-provider",
        model: "your-tts-model",
        voice: "your-voice",
      },
    },
  },
}
```

Set `enabled: false` on either to disable.

## Target formats

| Format                     | Description        |
| -------------------------- | ------------------ |
| `qqbot:c2c:OPENID`         | Private chat (C2C) |
| `qqbot:group:GROUP_OPENID` | Group chat         |
| `qqbot:channel:CHANNEL_ID` | Guild channel      |

> Each bot has its own set of user OpenIDs. An OpenID received by Bot A **cannot**
> be used to send messages via Bot B.

## Slash commands

Built-in commands intercepted before the AI queue:

| Command        | Description                          |
| -------------- | ------------------------------------ |
| `/bot-ping`    | Latency test                         |
| `/bot-version` | Show the OpenClaw framework version  |
| `/bot-help`    | List all commands                    |
| `/bot-upgrade` | Show the QQBot upgrade guide link    |
| `/bot-logs`    | Export recent gateway logs as a file |

Append `?` to any command for usage help (for example `/bot-upgrade ?`).

## Troubleshooting

- **Bot replies "gone to Mars":** credentials not configured or Gateway not started.
- **No inbound messages:** verify `appId` and `clientSecret` are correct, and the
  bot is enabled on the QQ Open Platform.
- **Proactive messages not arriving:** QQ may intercept bot-initiated messages if
  the user hasn't interacted recently.
- **Voice not transcribed:** ensure STT is configured and the provider is reachable.
