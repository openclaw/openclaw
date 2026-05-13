---
summary: "DingTalk (钉钉) bot overview, features, and configuration"
read_when:
  - You want to connect a DingTalk (钉钉) enterprise bot
  - You are configuring the DingTalk channel
title: DingTalk
---

DingTalk (钉钉) is Alibaba's enterprise collaboration platform. The bundled
`dingtalk-connector` channel runs in **Stream mode** — the gateway opens a
long-lived WebSocket-style stream to the DingTalk gateway, so no public webhook
endpoint is required.

**Status:** production-ready for enterprise internal bots ("企业内部机器人").
Supports DM + group chats, multi-account, AI Card streaming, image/audio/video
uploads, and DM/group security policies (open / pairing / allowlist).

---

## Quick start

<Note>
Requires OpenClaw 2026.4.10 or above. Run `openclaw --version` to check. Upgrade with `openclaw update`.
</Note>

<Steps>
  <Step title="Create a DingTalk enterprise internal bot">
  Open DingTalk Open Platform → 应用开发 → 企业内部应用 → 机器人, create a new
  bot, and grab its **Client ID (AppKey)** and **Client Secret (AppSecret)**.
  Enable the **Stream mode** option in the bot connection settings.
  </Step>

  <Step title="Run the channel setup wizard">
  ```bash
  openclaw channels login --channel dingtalk-connector
  ```
  The wizard supports both manual entry (paste Client ID / Secret) and a QR
  code flow (Device Authorization) for accounts that opt in.
  </Step>

  <Step title="After setup completes, restart the gateway">
  ```bash
  openclaw gateway restart
  ```
  </Step>
</Steps>

---

## Access control

### Direct messages

Configure `dmPolicy` on `channels.dingtalk-connector` to control who can DM
the bot:

- `"open"` — anyone in the corp/org can DM the bot
- `"pairing"` — unknown users get a pairing code; approve via
  `openclaw pairing approve dingtalk-connector <CODE>`
- `"allowlist"` — only users listed in `allowFrom` can chat

```bash
openclaw pairing list dingtalk-connector
openclaw pairing approve dingtalk-connector <CODE>
```

### Group chats

`channels.dingtalk-connector.groupPolicy`:

| Value         | Behavior                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `"open"`      | Respond in any group the bot is in (mention-gated by default)                                     |
| `"allowlist"` | Only respond to groups in `groupAllowFrom` or explicitly configured under `groups.<conversationId>` |
| `"disabled"`  | Disable all group messages                                                                        |

`channels.dingtalk-connector.requireMention` (default `true`) controls whether
group messages must @mention the bot to trigger it. Per-group override at
`channels.dingtalk-connector.groups.<conversationId>.requireMention`.

---

## Configuration reference

```json5
{
  channels: {
    "dingtalk-connector": {
      enabled: true,
      clientId: "dingxxxxxxxxxxxx",
      clientSecret: { source: "env", provider: "env", id: "DINGTALK_CLIENT_SECRET" },
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["cidXXXXX="],
      requireMention: true,
      // Stream-mode reply rendering inside groups: aicard | text | markdown
      groupReplyMode: "aicard",
      // Optional gateway endpoint override (advanced)
      // endpoint: "https://api.dingtalk.com",
    },
  },
}
```

`clientSecret` accepts either a plain string or a `SecretInput` reference:

```json5
{
  source: "env",      // "env" | "file" | "exec"
  provider: "env",    // provider id, e.g. "env" or a custom secret broker
  id: "DINGTALK_CLIENT_SECRET",
}
```

### Multiple accounts

```json5
{
  channels: {
    "dingtalk-connector": {
      defaultAccount: "main",
      accounts: {
        main: {
          enabled: true,
          name: "Primary bot",
          clientId: "dingxxxxxxxxxxxx",
          clientSecret: { source: "env", provider: "env", id: "DINGTALK_MAIN_SECRET" },
        },
        backup: {
          enabled: false,
          name: "Backup bot",
          clientId: "dingyyyyyyyyyyyy",
          clientSecret: { source: "env", provider: "env", id: "DINGTALK_BACKUP_SECRET" },
        },
      },
    },
  },
}
```

`defaultAccount` controls which account is used when outbound APIs do not
specify an `accountId`. The connector deduplicates by `clientId`: if two
enabled accounts share the same `clientId`, only the first one (in config
order) opens a Stream connection.

### Streaming AI Cards

In groups, set `groupReplyMode: "aicard"` (the default) to stream the reply
into an interactive AI Card that updates as the model generates text. Use
`"markdown"` or `"text"` if you prefer plain reply messages.

### Tooling

Enable optional tool surfaces under `channels.dingtalk-connector.tools`:

| Flag      | Purpose                                                |
| --------- | ------------------------------------------------------ |
| `docs`    | Allow agent to read/write DingTalk documents (`docs.*` gateway methods) |
| `media`   | Allow agent to send images/audio/video/files via media uploads |

These flags are inherited by `accounts.<id>.tools` so each bot can opt in or
out independently.

---

## Environment variables

| Variable | Purpose |
| -------- | ------- |
| `DINGTALK_CLIENT_ID` | Default `clientId` if not set in config |
| `DINGTALK_CLIENT_SECRET` | Default `clientSecret` if not set in config |
| `DINGTALK_REGISTRATION_BASE_URL` | Override the device-authorization base URL (advanced) |
| `DINGTALK_REGISTRATION_SOURCE` | Override the device-flow source identifier (advanced) |
| `DINGTALK_STRICT_DUPLICATE_LOAD` | Set to `1` to throw (instead of warn) when the plugin is loaded from multiple paths |

---

## Troubleshooting

### Bot does not receive messages

1. Ensure the bot is published in DingTalk Open Platform with **Stream mode** enabled
2. Ensure event subscriptions include `im.message.receive` (the only event the
   connector listens to today)
3. Ensure the gateway is running: `openclaw gateway status`
4. Confirm only **one** copy of `dingtalk-connector` is loaded (check
   `openclaw logs --follow` for the duplicate-load warning)

### Group messages ignored

1. Confirm the bot is added to the group
2. Confirm you @mention the bot (when `requireMention` is `true`, default)
3. Confirm the group is in `groupAllowFrom` or has an explicit
   `groups.<conversationId>` entry when `groupPolicy: "allowlist"`

### Client Secret leaked

1. Rotate the AppSecret in DingTalk Open Platform
2. Update `clientSecret` in your config (or rotate the env var if using a
   `SecretInput` reference)
3. Restart the gateway: `openclaw gateway restart`

### Resetting the channel

```bash
openclaw channels login --channel dingtalk-connector --reset
```

See [channel troubleshooting](/channels/troubleshooting) for general guidance.

---

## Capabilities

| Capability       | Supported |
| ---------------- | --------- |
| Direct messages  | ✓ |
| Group chats      | ✓ |
| Threads          | — (DingTalk has no first-class thread primitive) |
| Media (image / audio / video / file) | ✓ |
| Reactions        | — |
| Edit / replace   | — |
| AI Card streaming | ✓ |
| Multi-account    | ✓ |

---

## Gateway methods

The connector registers a `dingtalk-connector.*` RPC family on the gateway
that other plugins / agents can call:

- `dingtalk-connector.sendToUser` — proactively DM a user
- `dingtalk-connector.sendToGroup` — proactively post in a group
- `dingtalk-connector.send` — generic send (resolves user vs group)
- `dingtalk-connector.docs.read` / `docs.create` / `docs.append` /
  `docs.search` / `docs.list` — DingTalk Doc/Knowledge integration
- `dingtalk-connector.status` / `probe` / `listAccounts` — operational helpers
- `dingtalk-connector.fixStuckCards` — recover from a hung AI Card
- `dingtalk-connector.bootstrapBotIdentity` — initialize multi-bot identity
