---
summary: "Facebook Messenger channel support, capabilities, and configuration"
read_when:
  - Working on Messenger features or webhooks
title: "Messenger"
---

# Messenger (Meta Graph API)

Status: production-ready for Facebook Page DMs via Meta Graph API webhook. Plugin, installed separately.

## Quick setup (beginner)

1. Create a Meta Developer account and app at [developers.facebook.com](https://developers.facebook.com/).
2. Add the Messenger product to your app and connect a Facebook Page.
3. Generate a Page Access Token for your Page.
4. Copy the App Secret from **App Settings > Basic**.
5. Generate a secure verify token (any random string, e.g. `openssl rand -hex 32`).
6. Set the credentials:
   - Env: `MESSENGER_PAGE_ACCESS_TOKEN=...`, `MESSENGER_APP_SECRET=...`, `MESSENGER_VERIFY_TOKEN=...`
   - Or config: `channels.messenger.pageAccessToken`, `channels.messenger.appSecret`, `channels.messenger.verifyToken`.
7. Start the gateway.
8. In the Meta Developer Portal, configure the webhook URL pointing to your gateway (e.g. `https://your-domain.com/messenger/webhook`) and enter your verify token.
9. Subscribe to the `messages` and `messaging_postbacks` webhook fields.
10. DM access is pairing by default; approve the pairing code on first contact.

Minimal config:

```json5
{
  channels: {
    messenger: {
      enabled: true,
      pageAccessToken: "EAAx...",
      appSecret: "abc123...",
      verifyToken: "my-secret-verify-token",
      dmPolicy: "pairing",
    },
  },
}
```

## What it is

- A Facebook Messenger channel for Page DMs via the Meta Graph API.
- Webhook-based: Meta sends inbound messages to your gateway's HTTP endpoint.
- Deterministic routing: replies go back to the same Messenger conversation.
- DMs use the agent's main session by default.
- Supports text messages, postbacks, and media attachments (images, video, audio, files).

## Meta Developer Setup

This is the part most likely to trip you up. Facebook/Meta's developer platform requires several manual steps.

### 1) Create a Meta Developer account

Go to [developers.facebook.com](https://developers.facebook.com/) and sign up or log in with your Facebook account.

### 2) Create a new App

1. Click **My Apps > Create App**.
2. Select **Business** as the app type.
3. Choose **Messenger** as the use case.
4. Fill in your app name and contact email, then create the app.

### 3) Add Messenger and connect a Page

1. In your app dashboard, find **Messenger** under Products (it should already be added if you chose the Messenger use case).
2. Under **Access Tokens**, click **Add or Remove Pages** and connect the Facebook Page you want to use.
3. Click **Generate Token** next to your Page. Copy and save this token — this is your `pageAccessToken`.

### 4) Get the App Secret

1. Go to **App Settings > Basic**.
2. Click **Show** next to **App Secret** and copy it. This is your `appSecret`.

### 5) Configure the webhook

1. Under **Messenger > Settings > Webhooks**, click **Add Callback URL**.
2. Enter your webhook URL: `https://your-domain.com/messenger/webhook` (must be HTTPS and publicly reachable).
3. Enter your verify token (the value you set in `channels.messenger.verifyToken`).
4. Click **Verify and Save**. Meta will send a GET request with `hub.verify_token` and `hub.challenge` — your gateway must be running to respond.

### 6) Subscribe to webhook fields

After verifying, subscribe to at least these fields:

- **messages** — required; receives text messages and attachments.
- **messaging_postbacks** — recommended; receives postback button taps.

Optional fields (currently logged but not processed):

- **message_reads** — read receipts.
- **message_deliveries** — delivery confirmations.

### 7) Go Live

- For development/testing, the app works in Development Mode with Page admins and testers.
- To allow any Facebook user to message your Page, submit the app for **App Review** and request the `pages_messaging` permission.
- Switch the app to **Live** mode once approved.

**Important:** Facebook must be able to reach your webhook URL over the public internet. If your server is behind a firewall, NAT, or geo-blocking proxy, consider using a tunnel (e.g. Cloudflare Tunnel, ngrok) to expose the endpoint.

## Configuration

All keys live under `channels.messenger` in your OpenClaw config.

| Key               | Type    | Default                | Description                                                                      |
| ----------------- | ------- | ---------------------- | -------------------------------------------------------------------------------- |
| `enabled`         | boolean | `true`                 | Enable or disable the Messenger channel.                                         |
| `pageAccessToken` | string  | —                      | Page Access Token from the Meta Developer Portal.                                |
| `appSecret`       | string  | —                      | App Secret from App Settings > Basic. Used for webhook signature verification.   |
| `verifyToken`     | string  | —                      | Verify token for webhook setup. Any random string you choose.                    |
| `tokenFile`       | string  | —                      | Path to a file containing the Page Access Token (alternative to inline config).  |
| `secretFile`      | string  | —                      | Path to a file containing the App Secret (alternative to inline config).         |
| `name`            | string  | —                      | Friendly display name for this account.                                          |
| `dmPolicy`        | string  | `"pairing"`            | DM access control policy: `pairing`, `open`, `allowlist`, or `disabled`.         |
| `allowFrom`       | array   | —                      | Allowlist of sender IDs (strings or numbers). Used with `dmPolicy: "allowlist"`. |
| `responsePrefix`  | string  | —                      | Outbound response prefix override for this channel.                              |
| `webhookPath`     | string  | `"/messenger/webhook"` | Custom HTTP path for the webhook endpoint.                                       |
| `accounts`        | object  | —                      | Multi-account configuration (see below).                                         |

### Multi-account

Use `channels.messenger.accounts` to run multiple Facebook Pages from a single gateway. Each account key is an arbitrary ID with the same config fields as the top level:

```json5
{
  channels: {
    messenger: {
      accounts: {
        "page-a": {
          enabled: true,
          pageAccessToken: "EAAx...",
          appSecret: "abc...",
          verifyToken: "token-a",
          webhookPath: "/messenger/webhook/page-a",
        },
        "page-b": {
          enabled: true,
          pageAccessToken: "EAAy...",
          appSecret: "def...",
          verifyToken: "token-b",
          webhookPath: "/messenger/webhook/page-b",
        },
      },
    },
  },
}
```

Each account needs its own `webhookPath` and a matching webhook URL in the Meta Developer Portal.

## Environment variables

For the default account, credentials can be set via environment variables instead of config:

| Variable                      | Maps to                              |
| ----------------------------- | ------------------------------------ |
| `MESSENGER_PAGE_ACCESS_TOKEN` | `channels.messenger.pageAccessToken` |
| `MESSENGER_APP_SECRET`        | `channels.messenger.appSecret`       |
| `MESSENGER_VERIFY_TOKEN`      | `channels.messenger.verifyToken`     |

Environment variables are only used for the default account, not for named accounts under `channels.messenger.accounts`.

### Token resolution order

Credentials are resolved in this order (first match wins):

1. Account-level config value (e.g. `accounts.mypage.pageAccessToken`)
2. Account-level file (e.g. `accounts.mypage.tokenFile`)
3. Top-level config value (default account only)
4. Top-level file (default account only)
5. Environment variable (default account only)

## DM access control

Controlled by `channels.messenger.dmPolicy`:

| Policy              | Behavior                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pairing` (default) | Unknown senders receive a pairing code. Messages are ignored until the code is approved via `openclaw pairing approve messenger <CODE>`. Codes expire after 1 hour. |
| `open`              | All senders can message the bot.                                                                                                                                    |
| `allowlist`         | Only sender IDs listed in `channels.messenger.allowFrom` are accepted.                                                                                              |
| `disabled`          | All DMs are ignored.                                                                                                                                                |

## Webhook field subscriptions

Configure these in the Meta Developer Portal under Messenger > Settings > Webhooks.

| Field                 | Required    | Purpose                                                               |
| --------------------- | ----------- | --------------------------------------------------------------------- |
| `messages`            | Yes         | Receives text messages and media attachments from users.              |
| `messaging_postbacks` | Recommended | Receives postback payloads when users tap structured message buttons. |
| `message_reads`       | Optional    | Read receipt events (logged, not currently processed).                |
| `message_deliveries`  | Optional    | Delivery confirmation events (logged, not currently processed).       |

## Webhook signature verification

All inbound POST requests are verified using HMAC-SHA256. The `X-Hub-Signature-256` header sent by Meta is compared against a hash computed with your `appSecret`. Requests with missing or invalid signatures are rejected (400/401).

This is automatic — just make sure your `appSecret` is correctly configured.

## Limits

- Outbound text is chunked to 2000 characters (Messenger API limit).
- Long messages are split on Markdown boundaries (paragraphs, sentences) when possible.
- Media attachments (images, video, audio, files) are forwarded via URL.

## Commands

Messenger does not have native slash command support. Users can type text commands (e.g. `/new`, `/reset`, `/status`) as regular messages and they will be handled automatically. Text commands work on all channels regardless of native command support.

Common text commands:

- `/new` or `/reset` — start a new session (clears conversation history).
- `/status` — show current agent and session status.
- `/model` — show or change the active model.

Full command list: [Slash commands](/tools/slash-commands).

## Troubleshooting

**Webhook verification fails:**

- Ensure the gateway is running and reachable at the webhook URL before clicking "Verify and Save" in the Meta Portal.
- Confirm `verifyToken` in your config matches exactly what you entered in the Meta Portal.
- The endpoint must be HTTPS. HTTP will be rejected by Meta.

**Messages not arriving:**

- Check that you subscribed to the `messages` webhook field in the Meta Portal.
- Verify the app is in Live mode (or the sender is an app admin/tester in Development mode).
- Check gateway logs: `openclaw logs --follow` (look for `messenger:` prefixed log lines).
- If behind a geo-blocking proxy or firewall, Facebook's webhook servers may be blocked. Facebook sends webhooks from a range of IPs. Use a tunnel (Cloudflare Tunnel, ngrok) or whitelist Meta's IP ranges.

**Signature validation failures (401):**

- Confirm `appSecret` matches the value in **App Settings > Basic** in the Meta Portal.
- If you regenerated the App Secret, update your config and restart the gateway.
- Make sure the raw request body is not modified by a proxy before it reaches the gateway (signature is computed over the exact bytes).

**Token errors (Page Access Token):**

- Page Access Tokens can expire. Generate a long-lived token or use a System User token for production.
- If using `tokenFile`, confirm the file exists and is readable by the gateway process.
- Test your token: `curl "https://graph.facebook.com/me?access_token=YOUR_TOKEN"` should return your Page info.

**Bot replies but user doesn't see them:**

- Check that the Page Access Token has the `pages_messaging` permission.
- In Development mode, only app admins, developers, and testers can receive messages.

## Configuration reference (Messenger)

Provider options:

- `channels.messenger.enabled`: enable/disable channel startup.
- `channels.messenger.pageAccessToken`: Page Access Token (Meta Developer Portal).
- `channels.messenger.appSecret`: App Secret for webhook signature verification.
- `channels.messenger.verifyToken`: verify token for webhook setup.
- `channels.messenger.tokenFile`: read Page Access Token from file path.
- `channels.messenger.secretFile`: read App Secret from file path.
- `channels.messenger.name`: friendly display name.
- `channels.messenger.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `channels.messenger.allowFrom`: DM allowlist (sender IDs).
- `channels.messenger.responsePrefix`: outbound response prefix override.
- `channels.messenger.webhookPath`: custom webhook HTTP path (default: `/messenger/webhook`).
- `channels.messenger.accounts.<account>.*`: per-account overrides (same fields as top level).
