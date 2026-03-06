---
summary: "Pumble bot setup and OpenClaw config"
read_when:
  - Setting up Pumble
  - Debugging Pumble routing
title: "Pumble"
---

# Pumble (plugin)

Status: supported via plugin (bot token + webhook events). Channels, groups, and DMs are supported.
Pumble is a Slack-style team messaging platform by CAKE.com; see the official site at
[pumble.com](https://pumble.com) for product details.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Pumble DMs default to pairing mode.
  </Card>
  <Card title="Channel routing" icon="route" href="/channels/channel-routing">
    Route channels to different agents.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair playbooks.
  </Card>
</CardGroup>

## Plugin required

Pumble ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/pumble
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/pumble
```

If you choose Pumble during configure/onboarding and a git checkout is detected,
OpenClaw will offer the local install path automatically.

Details: [Plugins](/tools/plugin)

## Setup overview

Setting up Pumble requires two stages:

1. **Create a Pumble app** and complete the OAuth install flow using the `pumble-cli` scaffolding tool to obtain your credentials and bot token.
2. **Configure OpenClaw** with the credentials from step 1.

## Stage 1 - Create the Pumble app and get credentials

Pumble apps are created and authorized using the `pumble-sdk` and `pumble-cli` npm packages. You need a small scaffolding project to run the OAuth flow once and capture the resulting tokens.

<Steps>
  <Step title="Create a scaffolding project">
    Create a new directory and initialize it:

```bash
mkdir pumble-app && cd pumble-app
npm init -y
npm install pumble-sdk@1.0.2
npm install --save-dev pumble-cli@1.0.2 typescript
```

  </Step>

  <Step title="Create a manifest">
    Create `manifest.json` in the project root. This defines the app name, scopes, and capabilities:

```json
{
  "name": "openclaw",
  "displayName": "OpenClaw",
  "botTitle": "Chat with your OpenClaw agents using Pumble",
  "bot": true,
  "socketMode": false,
  "scopes": {
    "botScopes": [
      "messages:read",
      "messages:write",
      "channels:read",
      "channels:list",
      "user:read",
      "reaction:read",
      "reaction:write",
      "files:read",
      "files:write"
    ],
    "userScopes": ["messages:read"]
  }
}
```

  </Step>

  <Step title="Create a minimal app entry point">
    Create `src/main.ts`:

```typescript
import { App, JsonFileTokenStore, start } from "pumble-sdk";

const addon: App = {
  events: [
    {
      name: "NEW_MESSAGE",
      handler: (ctx) => {
        console.log("Received new message!", ctx.payload.body);
      },
    },
  ],
  eventsPath: "/hook",
  redirect: { enable: true, path: "/redirect" },
  tokenStore: new JsonFileTokenStore("tokens.json"),
};

start(addon);
```

  </Step>

  <Step title="Run pumble-cli to register the app">
    Run the CLI dev command to register the app with Pumble and start the OAuth flow:

```bash
npx pumble-cli
```

This will: - Register your app with the Pumble API - Generate a `.pumbleapprc` file containing your **App ID**, **App Key**, **Client Secret**, and **Signing Secret** - Open a browser window for the OAuth authorization flow - After you authorize, write `tokens.json` with the **Bot Token** and **Bot ID**

<Warning>
Keep the `.pumbleapprc` and `tokens.json` files safe — they contain your app secrets and access tokens. Do not commit them to version control.
</Warning>

  </Step>

  <Step title="Collect your credentials">
    After the OAuth flow completes, you will have two files with the credentials you need:

    **`.pumbleapprc`** contains:
    - `PUMBLE_APP_ID` — your app's unique ID
    - `PUMBLE_APP_KEY` — starts with `xpat-`
    - `PUMBLE_APP_CLIENT_SECRET` — starts with `xpcls-`
    - `PUMBLE_APP_SIGNING_SECRET` — starts with `xpss-`

    **`tokens.json`** contains (nested under a workspace ID key):
    - `botToken` — a JWT used as the bot's access token
    - `botId` — the bot's user ID (useful for `botUserId` config)

  </Step>
</Steps>

<Note>
You only need to run `pumble-cli` once to create the app and complete the OAuth flow. After that, the credentials are static and can be copied into your OpenClaw config. You do not need to keep the scaffolding project running.
</Note>

## Stage 2 - Configure OpenClaw

<Steps>
  <Step title="Install the Pumble plugin">

```bash
openclaw plugins install @openclaw/pumble
```

  </Step>

  <Step title="Add credentials to config">
    Copy the five credentials from Stage 1 into your OpenClaw config:

```json5
{
  channels: {
    pumble: {
      enabled: true,
      appId: "your-app-id", // from .pumbleapprc PUMBLE_APP_ID
      appKey: "xpat-...", // from .pumbleapprc PUMBLE_APP_KEY
      clientSecret: "xpcls-...", // from .pumbleapprc PUMBLE_APP_CLIENT_SECRET
      signingSecret: "xpss-...", // from .pumbleapprc PUMBLE_APP_SIGNING_SECRET
      botToken: "eyJhbGci...", // from tokens.json botToken
      dmPolicy: "pairing",
    },
  },
}
```

    Or use the interactive setup:

```bash
openclaw configure
```

  </Step>

  <Step title="Invite the bot to channels">
    In Pumble, invite the bot user to any channels you want it to monitor. The bot will not receive messages from channels it has not been added to.
  </Step>

  <Step title="Start the gateway">

```bash
openclaw gateway
```

    You should see logs like:
    - `pumble: starting monitor for account "default"`
    - `pumble: tunnel open at https://...`
    - `pumble: HTTP webhook server listening on port 5111`

  </Step>
</Steps>

### REST-only config

If you only need outbound sends (no real-time inbound messages), you can configure with just the bot token:

```json5
{
  channels: {
    pumble: {
      enabled: true,
      botToken: "eyJhbGci...",
      dmPolicy: "pairing",
    },
  },
}
```

<Note>
WebSocket mode requires all four SDK credentials (`appId`, `appKey`, `clientSecret`, `signingSecret`) plus `botToken`. Without the SDK credentials, the monitor starts in REST-only mode (outbound sends work, but inbound messages are not received in real-time).
</Note>

## Environment variables (default account)

Set these on the gateway host if you prefer env vars:

- `PUMBLE_APP_ID=...`
- `PUMBLE_APP_KEY=...`
- `PUMBLE_APP_CLIENT_SECRET=...`
- `PUMBLE_APP_SIGNING_SECRET=...`
- `PUMBLE_BOT_TOKEN=...`

Env vars apply only to the **default** account (`default`). Other accounts must use config values.

## Access control (DMs)

- Default: `channels.pumble.dmPolicy = "pairing"` (unknown senders get a pairing code).
- Approve via:
  - `openclaw pairing list pumble`
  - `openclaw pairing approve pumble <CODE>`
- Public DMs: `channels.pumble.dmPolicy="open"` plus `channels.pumble.allowFrom=["*"]`.

## Channels (groups)

- Default: `channels.pumble.groupPolicy = "allowlist"` (mention-gated).
- Allowlist senders with `channels.pumble.groupAllowFrom` (user IDs).
- Open channels: `channels.pumble.groupPolicy="open"` (mention-gated).
- Channel allowlist: `channels.pumble.channelAllowlist` restricts which channels the bot listens to (empty = all channels).

## Mentions

Channel messages are mention-gated by default (`requireMention: true`).

Configure mention patterns via `messages.groupChat.mentionPatterns` or per-agent `agents.list[].groupChat.mentionPatterns`.

Per-account override: `channels.pumble.accounts.<id>.requireMention`.

## Targets for outbound delivery

Use these target formats with `openclaw message send` or cron/webhooks:

- `channel:<id>` for a channel message
- `user:<id>` for a DM
- `pumble:<id>` for a DM (alias)
- `#<name>` for a channel by name

Bare IDs are treated as channels.

## Threading

Thread replies are supported. Inbound messages with a thread root ID are routed to thread-scoped sessions. Outbound replies are sent as thread replies when the inbound message was in a thread.

## Webhook port and tunneling

The Pumble plugin starts a local HTTP server for receiving webhook events. The default port is **5111**.

Override per-account with `channels.pumble.webhookPort` (or `channels.pumble.accounts.<id>.webhookPort`):

```json5
{
  channels: {
    pumble: {
      webhookPort: 5200,
    },
  },
}
```

By default, the plugin uses [localtunnel](https://github.com/localtunnel/localtunnel) to expose the local webhook server as a public HTTPS URL. The tunnel URL is registered with the Pumble API automatically on each gateway start.

If you have your own public URL (e.g. via ngrok or Cloudflare Tunnel), set `webhookUrl` to skip localtunnel:

```json5
{
  channels: {
    pumble: {
      webhookUrl: "https://your-public-url.example.com",
    },
  },
}
```

The local HTTP server still binds to `webhookPort` but the automatic tunnel is skipped.

## Multi-account

Pumble supports multiple accounts under `channels.pumble.accounts`:

```json5
{
  channels: {
    pumble: {
      accounts: {
        default: {
          name: "Primary",
          appId: "app-1",
          appKey: "xpat-...",
          clientSecret: "xpcls-...",
          signingSecret: "xpss-...",
          botToken: "eyJhbGci...",
        },
        alerts: {
          name: "Alerts",
          appId: "app-2",
          appKey: "xpat-...",
          clientSecret: "xpcls-...",
          signingSecret: "xpss-...",
          botToken: "eyJhbGci...",
        },
      },
    },
  },
}
```

## Troubleshooting

- **No inbound messages**: ensure all four SDK credentials are configured (`appId`, `appKey`, `clientSecret`, `signingSecret`). Without them the monitor runs in REST-only mode and cannot receive messages. Check logs for `pumble: SDK credentials missing, running in REST-only mode`.
- **Auth errors**: verify the bot token is valid with `openclaw channels status --probe`.
- **Bot not responding in channels**: make sure the bot has been invited to the channel in Pumble. Also check `groupPolicy`, `channelAllowlist`, and `requireMention` settings.
- **DM messages ignored**: check `dmPolicy` and pairing approvals (`openclaw pairing list pumble`).
- **Tunnel errors / reconnection loops**: if using the default localtunnel, check your network connectivity. For production use, consider setting a static `webhookUrl` via ngrok or Cloudflare Tunnel for more reliable connectivity.
- **Port conflicts**: if port 5111 is in use, set `webhookPort` to a different value.
- **Multi-account issues**: env vars only apply to the `default` account.
- **Bot user ID not resolved**: set `channels.pumble.botUserId` to the `botId` value from `tokens.json`. This is used for self-message filtering.

## Related

- [Pairing](/channels/pairing)
- [Channel routing](/channels/channel-routing)
- [Groups](/channels/groups)
- [Troubleshooting](/channels/troubleshooting)
