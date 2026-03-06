---
summary: "Minimum working configs for channels that depend on webhooks, app credentials, or external service callbacks"
read_when:
  - You are configuring channels that need a public callback or app credentials
  - You want the shortest path for webhook based channels
title: "Webhooks And App Credentials"
---

# Webhooks And App Credentials

<Note>
Use this page to choose a setup path. The canonical per-channel configuration docs live under [Chat Channels](/channels).
</Note>

These channels require an external service to call back into the gateway, or they require app credentials that are tied to a hosted API integration.
Use HTTPS and expose only the path each provider needs.

## BlueBubbles

Config path: `channels.bluebubbles`

What you need:

- a BlueBubbles server running on macOS
- the server URL and API password
- a webhook path that BlueBubbles can reach

```json5
{
  channels: {
    bluebubbles: {
      enabled: true,
      serverUrl: "http://gateway-host.example:1234",
      password: "example-password",
      webhookPath: "/bluebubbles-webhook",
    },
  },
}
```

Enable the BlueBubbles web API, set a password, and point its webhook to your gateway with the same password.
Details: [BlueBubbles](/channels/bluebubbles)

## Google Chat

Config path: `channels.googlechat`

What you need:

- a Google Chat app configured for an HTTP endpoint
- a service account JSON key on the gateway host
- the webhook audience settings used by your Chat app

```json5
{
  channels: {
    googlechat: {
      serviceAccountFile: "~/.openclaw/googlechat-service-account.json",
      audienceType: "space",
      audience: "spaces/AAAAexample",
      webhookPath: "/googlechat",
    },
  },
}
```

Only the webhook path needs to be public. Keep the rest of the gateway private when possible.
Details: [Google Chat](/channels/googlechat)

## LINE

Config path: `channels.line`

What you need:

- a LINE Messaging API channel
- a channel access token and channel secret
- a public webhook URL

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

Set the LINE webhook to `https://gateway-host.example/line/webhook` unless you override `webhookPath`.
Details: [LINE](/channels/line)

## Feishu

Config path: `channels.feishu`

What you need:

- the Feishu plugin
- a Feishu or Lark app ID and app secret
- WebSocket mode or webhook mode if you need HTTP callbacks

```json5
{
  channels: {
    feishu: {
      accounts: {
        default: {
          appId: "cli_xxx",
          appSecret: "your-feishu-secret",
        },
      },
      dmPolicy: "pairing",
    },
  },
}
```

WebSocket mode is the easiest default because it avoids exposing a webhook. For Lark, set `domain: "lark"`.
Details: [Feishu](/channels/feishu)

## Microsoft Teams

Config path: `channels.msteams`

What you need:

- an Azure Bot app ID, app password, and tenant ID
- a public URL or tunnel that can reach the Teams webhook path

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "APP_ID",
      appPassword: "APP_PASSWORD",
      tenantId: "TENANT_ID",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Install the Teams app package after the webhook is reachable and the gateway is running.
Details: [Microsoft Teams](/channels/msteams)

## Nextcloud Talk

Config path: `channels.nextcloud-talk`

What you need:

- the Nextcloud Talk plugin
- a bot created with `occ talk:bot:install`
- the Nextcloud base URL and shared bot secret

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

If your gateway sits behind a reverse proxy, set `webhookPublicUrl` so Nextcloud can reach the callback correctly.
Details: [Nextcloud Talk](/channels/nextcloud-talk)

## Synology Chat

Config path: `channels.synology-chat`

What you need:

- the Synology Chat plugin
- an outgoing webhook token and incoming webhook URL
- a webhook path on the gateway

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      token: "synology-outgoing-token",
      incomingUrl: "https://nas.example.com/webapi/entry.cgi?...token=...",
      webhookPath: "/webhook/synology",
      dmPolicy: "allowlist",
      allowedUserIds: ["123456"],
    },
  },
}
```

Synology Chat is DM focused. In `allowlist` mode, keep `allowedUserIds` non-empty or the route will fail closed.
Details: [Synology Chat](/channels/synology-chat)

## Related guides

- [Channel configuration overview](/gateway/channel-configuration-guides)
- [Bot tokens and QR login](/gateway/channel-configuration-bot-tokens-and-qr)
- [Account logins and self hosted channels](/gateway/channel-configuration-account-logins)
- [External clients and legacy integrations](/gateway/channel-configuration-external-clients)