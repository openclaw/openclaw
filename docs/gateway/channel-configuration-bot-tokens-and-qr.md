---
summary: "Minimum working channel configs for token based and QR login channels"
read_when:
  - You are configuring a bot token or QR based channel
  - You want the minimum config before reading the full channel docs
title: "Bot Tokens And QR Login"
---

# Bot Tokens And QR Login

<Note>
Use this page to choose a setup path. The canonical per-channel configuration docs live under [Chat Channels](/channels).
</Note>

These channels are the fastest to bring up when you already have a bot token or can scan a QR code on the gateway host.
All examples below show the minimum working config plus the credential or login step that must happen outside the config file.

## WhatsApp

Config path: `channels.whatsapp`

What you need:

- a WhatsApp account to link on the gateway host
- a DM policy and allowlist that match your usage model

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

Then run `openclaw channels login --channel whatsapp` and scan the QR code.
Details: [WhatsApp](/channels/whatsapp)

## Telegram

Config path: `channels.telegram`

What you need:

- a bot token from `@BotFather`
- numeric Telegram user IDs if you use `allowFrom` or `groupAllowFrom`

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: {
        "*": { requireMention: true },
      },
    },
  },
}
```

Telegram does not use `openclaw channels login`. Set the token in config or env, then start the gateway.
Details: [Telegram](/channels/telegram)

## Discord

Config path: `channels.discord`

What you need:

- a Discord bot token
- a Discord application with Message Content Intent enabled

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_DISCORD_BOT_TOKEN",
    },
  },
}
```

Create the bot in the Discord Developer Portal, invite it to your server, then start the gateway.
Details: [Discord](/channels/discord)

## Slack

Config path: `channels.slack`

What you need:

- Socket Mode: `appToken` + `botToken`
- or HTTP mode: `botToken` + `signingSecret`

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

Socket Mode is the easiest default because it does not require a public webhook.
Details: [Slack](/channels/slack)

## Mattermost

Config path: `channels.mattermost`

What you need:

- a Mattermost bot token
- the Mattermost base URL

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

Install the plugin first, then start the gateway after the token and base URL are set.
Details: [Mattermost](/channels/mattermost)

## Twitch

Config path: `channels.twitch`

What you need:

- a Twitch bot account username
- an OAuth access token and client ID
- the channel name to join
- a sender allowlist or role policy

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "streamername",
      allowFrom: ["123456789"],
    },
  },
}
```

Generate the token with Twitch Token Generator and keep `requireMention` enabled unless you want always on chat replies.
Details: [Twitch](/channels/twitch)

## Zalo

Config path: `channels.zalo`

What you need:

- a bot token from the Zalo Bot Platform

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

After the plugin is installed and the token is set, restart the gateway and approve the first pairing request.
Details: [Zalo](/channels/zalo)

## Zalo Personal

Config path: `channels.zalouser`

What you need:

- the `@openclaw/zalouser` plugin
- a personal Zalo account you can link with QR on the gateway host

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

Then run `openclaw channels login --channel zalouser` and scan the QR code in the Zalo app.
Details: [Zalo Personal](/channels/zalouser)

## Related guides

- [Channel configuration overview](/gateway/channel-configuration-guides)
- [Webhooks and app credentials](/gateway/channel-configuration-webhooks-and-apps)
- [Account logins and self hosted channels](/gateway/channel-configuration-account-logins)
- [External clients and legacy integrations](/gateway/channel-configuration-external-clients)