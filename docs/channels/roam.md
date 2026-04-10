---
summary: "Roam HQ channel setup, configuration, and multi-account support"
read_when:
  - Setting up Roam HQ in OpenClaw
  - Configuring Roam bot API keys and webhooks
title: "Roam"
---

# Roam

Connect OpenClaw to [Roam](https://ro.am) team messaging so your bot can send and receive messages, handle media attachments, and participate in group conversations.

---

## Bundled plugin

Roam ships as a bundled channel plugin.

| Plugin id | Package          | Channel id |
| --------- | ---------------- | ---------- |
| `roam`    | `@openclaw/roam` | `roam`     |

Enable it during onboarding or install manually:

```bash
openclaw plugin install roam
```

---

## Quickstart

### Method 1: Onboarding wizard

```bash
openclaw onboard
# Select "Roam HQ" from the channel list and follow the prompts.
```

### Method 2: Manual configuration

1. Create a bot token in **Roam Administration > Developer**.
2. Add the token to your OpenClaw config:

```json5
// openclaw.yaml or openclaw.json
{
  channels: {
    roam: {
      apiKey: "your-roam-bot-token",
    },
  },
}
```

3. Start or restart the gateway:

```bash
openclaw gateway run
```

---

## Webhook setup

Roam delivers inbound messages via webhooks. OpenClaw registers a local HTTP route (default path: `/roam-webhook`) and can auto-subscribe to Roam webhook events when `webhookUrl` is configured.

### Auto-subscription

Set `webhookUrl` to the full public URL of your gateway webhook endpoint. OpenClaw will call `webhook.subscribe` on startup and `webhook.unsubscribe` on shutdown:

```json5
{
  channels: {
    roam: {
      apiKey: "your-token",
      webhookUrl: "https://your-gateway-host.example.com/roam-webhook",
    },
  },
}
```

### Manual subscription

If you prefer to register webhooks yourself (for example, behind a reverse proxy with a different path), set only `webhookPath` and register the `chat.message` event in Roam Administration:

```json5
{
  channels: {
    roam: {
      apiKey: "your-token",
      webhookPath: "/custom/roam-inbound",
    },
  },
}
```

---

## Access control

### DM policy

The default DM policy is `pairing`. New senders receive a one-time pairing challenge before they can chat with the bot. Change it with `dmPolicy`:

```json5
{
  channels: {
    roam: {
      dmPolicy: "open", // allow all DMs
      // dmPolicy: "pairing", // default: require pairing
      // dmPolicy: "allowlist", // only allowFrom entries
    },
  },
}
```

### Group policy

Groups are allowlisted by default. Add group chat IDs to the `groups` map:

```json5
{
  channels: {
    roam: {
      groupPolicy: "allowlist",
      groups: {
        "group-chat-uuid": {
          requireMention: true,
        },
        "*": {
          // Wildcard: allow all groups but require mention
          requireMention: true,
        },
      },
    },
  },
}
```

### Sender allowlists

Restrict who can message the bot with `allowFrom` (DMs) and `groupAllowFrom` (groups). Roam user UUIDs work with or without the `U-` tag prefix:

```json5
{
  channels: {
    roam: {
      allowFrom: ["01234567-abcd-4000-8000-000000000000"],
      groupAllowFrom: ["U-01234567-abcd-4000-8000-000000000000"],
    },
  },
}
```

---

## Multi-account

Configure multiple Roam bot accounts under `accounts`. Each account gets its own webhook path, API key, and policy settings:

```json5
{
  channels: {
    roam: {
      accounts: {
        engineering: {
          apiKey: "token-for-eng-bot",
          webhookUrl: "https://host.example.com/roam-webhook-engineering",
          groups: { "*": { requireMention: true } },
        },
        support: {
          apiKey: "token-for-support-bot",
          webhookUrl: "https://host.example.com/roam-webhook-support",
          dmPolicy: "open",
          apiBaseUrl: "https://api.roam-staging.example.com",
        },
      },
    },
  },
}
```

---

## Configuration reference

| Key              | Type     | Default             | Description                                   |
| ---------------- | -------- | ------------------- | --------------------------------------------- |
| `apiKey`         | secret   | —                   | Roam bot API token                            |
| `apiKeyFile`     | string   | —                   | Path to file containing the API key           |
| `apiBaseUrl`     | string   | `https://api.ro.am` | Override API base URL (per-account supported) |
| `webhookUrl`     | string   | —                   | Full public URL for auto-subscription         |
| `webhookPath`    | string   | `/roam-webhook`     | Local HTTP route path                         |
| `dmPolicy`       | string   | `pairing`           | `open`, `pairing`, or `allowlist`             |
| `groupPolicy`    | string   | `allowlist`         | `open`, `allowlist`, or `disabled`            |
| `allowFrom`      | string[] | —                   | DM sender allowlist (Roam user UUIDs)         |
| `groupAllowFrom` | string[] | —                   | Group sender allowlist                        |
| `groups`         | object   | —                   | Per-group config (keyed by group UUID or `*`) |
| `blockStreaming` | boolean  | —                   | Disable block streaming for this account      |

### Per-group keys

| Key              | Type     | Default | Description                             |
| ---------------- | -------- | ------- | --------------------------------------- |
| `requireMention` | boolean  | `true`  | Require @mention to wake the bot        |
| `enabled`        | boolean  | `true`  | Enable/disable bot for this group       |
| `allowFrom`      | string[] | —       | Sender allowlist for this group         |
| `systemPrompt`   | string   | —       | Additional system prompt for this group |
| `skills`         | string[] | —       | Restrict skills loaded for this group   |
| `tools`          | object   | —       | Tool allow/deny policy for this group   |
