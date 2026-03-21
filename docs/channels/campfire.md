---
summary: "Campfire webhook setup and OpenClaw config"
read_when:
  - Setting up Campfire with OpenClaw
  - Debugging Campfire webhook delivery
title: "Campfire"
---

# Campfire (plugin)

Status: supported via plugin as a room channel using Campfire webhooks.
OpenClaw accepts inbound Campfire webhook events and posts plain-text replies to the room message URL.

## Plugin required

Campfire is plugin-based and is not bundled with the default core channel install.

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/campfire
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/campfire
```

Details: [Plugins](/tools/plugin)

## Quick setup

1. Install and enable the Campfire plugin.
2. Configure your Campfire account in OpenClaw with:
   - `baseUrl` (for example `https://3.basecamp.com/1234567`)
   - `botKey`
   - Optional `webhookSecret`
3. Point Campfire webhook delivery to your OpenClaw gateway path:
   - Default: `/channels/campfire/webhook/default`
   - Per-account default: `/channels/campfire/webhook/<account-id>`
4. If you set `webhookSecret`, include it as a query parameter in the webhook URL:
   - `?secret=<webhookSecret>`
5. Restart gateway and send a message in a configured Campfire room.

Minimal config:

```json5
{
  channels: {
    campfire: {
      enabled: true,
      baseUrl: "https://3.basecamp.com/1234567",
      botKey: "campfire-bot-key",
      webhookSecret: "shared-secret",
      allowFrom: ["42"],
      webhookPath: "/channels/campfire/webhook/default",
      textChunkLimit: 4000,
    },
  },
}
```

## Access control

- `allowFrom` is a Campfire user-id allowlist for inbound webhook events.
- Empty `allowFrom` means allow all senders.
- `webhookSecret` protects inbound requests and must match the `secret` query parameter.

## Outbound delivery

- Replies are sent as `text/plain`.
- Long replies are split sequentially by `textChunkLimit`.
- Manual sends support room message URLs as targets:

```bash
openclaw message send --channel campfire --target "https://3.basecamp.com/1234567/buckets/999/chats/111/messages/222" --text "Hello from OpenClaw"
```

- Target URLs must match `channels.campfire.baseUrl` origin.

## Multi-account

Use `channels.campfire.accounts` for multiple Campfire workspaces or bot identities.
Each account can override base URL, bot key, webhook path, allowlist, and chunking.

```json5
{
  channels: {
    campfire: {
      defaultAccount: "default",
      accounts: {
        default: {
          baseUrl: "https://3.basecamp.com/1234567",
          botKey: "campfire-key-a",
          webhookPath: "/channels/campfire/webhook/default",
        },
        support: {
          baseUrl: "https://3.basecamp.com/7654321",
          botKey: "campfire-key-b",
          webhookPath: "/channels/campfire/webhook/support",
          allowFrom: ["99", "100"],
        },
      },
    },
  },
}
```

## Configuration reference (Campfire)

Full configuration: [Configuration](/gateway/configuration)

- `channels.campfire.enabled`: enable/disable startup.
- `channels.campfire.baseUrl`: Campfire base URL for the workspace.
- `channels.campfire.botKey`: Campfire bot API key.
- `channels.campfire.webhookSecret`: optional shared secret checked from `?secret=`.
- `channels.campfire.allowFrom`: inbound allowlist of Campfire user IDs (as strings).
- `channels.campfire.webhookPath`: inbound webhook route path.
- `channels.campfire.textChunkLimit`: outbound chunk size in characters.
- `channels.campfire.defaultAccount`: default account id for sends.
- `channels.campfire.accounts`: per-account overrides.
