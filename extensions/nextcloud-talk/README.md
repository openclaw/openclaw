# Nextcloud Talk extension

Channel plugin that connects OpenClaw to [Nextcloud Talk](https://nextcloud.com/talk/) via webhook bots.

## Prerequisites

- Nextcloud instance with the **Talk** app (Spreed) enabled.
- A registered bot via `occ talk:bot:install`. This gives you a **bot secret** and registers a webhook URL.

Register the bot (run on your Nextcloud server):

```sh
sudo -u www-data php occ talk:bot:install \
  "OpenClaw" \
  "https://your-gateway-host:8788/nextcloud-talk-webhook" \
  "AI assistant powered by OpenClaw" \
  "HMAC_SECRET_YOU_CHOOSE"
```

Replace the webhook URL with your gateway's public address and the HMAC secret with a strong random string.

## Install

```sh
openclaw plugin install nextcloud-talk
```

Or from the repo (development):

```sh
cd extensions/nextcloud-talk && npm install --omit=dev
```

## Configure

Set the required config values:

```sh
openclaw config set channels.nextcloud-talk.baseUrl "https://cloud.example.com"
openclaw config set channels.nextcloud-talk.botSecret "YOUR_HMAC_SECRET"
```

Or use a secret file instead of an inline secret:

```sh
openclaw config set channels.nextcloud-talk.botSecretFile "/path/to/secret.txt"
```

### Webhook server

The extension starts a local HTTP server to receive Nextcloud webhooks.

| Key                | Default                   | Description                          |
| ------------------ | ------------------------- | ------------------------------------ |
| `webhookPort`      | `8788`                    | Port the webhook server listens on   |
| `webhookHost`      | `0.0.0.0`                 | Bind address                         |
| `webhookPath`      | `/nextcloud-talk-webhook` | Endpoint path                        |
| `webhookPublicUrl` | —                         | Public URL if behind a reverse proxy |

### Access control

| Key              | Default     | Description                                            |
| ---------------- | ----------- | ------------------------------------------------------ |
| `allowFrom`      | —           | User IDs allowed to DM the bot                         |
| `groupAllowFrom` | —           | User IDs allowed to interact in group rooms            |
| `groupPolicy`    | `allowlist` | Group message policy (`open`, `allowlist`, `disabled`) |
| `dmPolicy`       | `pairing`   | Direct message policy                                  |

User IDs are normalized: the `users/` prefix (sent by Nextcloud webhooks) and channel prefixes (`nc:`, `nc-talk:`, `nextcloud-talk:`) are stripped automatically, and matching is case-insensitive.

### Per-room config

Rooms are keyed by room token. Use `*` as a wildcard key for defaults.

```sh
openclaw config set channels.nextcloud-talk.rooms.abc123.requireMention true
openclaw config set channels.nextcloud-talk.rooms.abc123.allowFrom '["alice","bob"]'
```

Room-level options: `requireMention`, `allowFrom`, `tools`, `skills`, `enabled`, `systemPrompt`.

### Multi-account

For multiple Nextcloud instances, use the `accounts` key:

```sh
openclaw config set channels.nextcloud-talk.accounts.work.baseUrl "https://work.example.com"
openclaw config set channels.nextcloud-talk.accounts.work.botSecret "SECRET_WORK"
openclaw config set channels.nextcloud-talk.accounts.personal.baseUrl "https://home.example.com"
openclaw config set channels.nextcloud-talk.accounts.personal.botSecret "SECRET_HOME"
```

## Run

Start the gateway as usual:

```sh
openclaw gateway run
```

The Nextcloud Talk webhook server starts automatically on the configured port.

## Layout

| Path               | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `index.ts`         | Plugin entry point                                            |
| `src/channel.ts`   | Channel implementation and lifecycle hooks                    |
| `src/monitor.ts`   | Webhook HTTP server (signature verification, message routing) |
| `src/send.ts`      | Outbound message and reaction delivery                        |
| `src/policy.ts`    | Allowlist matching and room/group access control              |
| `src/accounts.ts`  | Multi-account credential resolution                           |
| `src/signature.ts` | HMAC-SHA256 signature generation                              |
| `src/runtime.ts`   | Plugin runtime bridge                                         |
| `src/types.ts`     | TypeScript type definitions                                   |

## Signature verification

Both inbound (webhook) and outbound (API) use HMAC-SHA256 with the bot secret. Nextcloud signs inbound webhooks over `RANDOM + BODY`. For outbound sends, Nextcloud verifies the signature over `RANDOM + MESSAGE_TEXT` (not the full JSON body).

## Aliases

The channel can be referenced as `nextcloud-talk`, `nc-talk`, or `nc` in CLI commands.
