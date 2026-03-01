---
summary: "DeJoy channel setup, credentials, and configuration"
read_when:
  - Working on DeJoy channel features
  - Setting up DeJoy credentials in onboarding
title: "DeJoy"
---

# DeJoy (plugin)

DeJoy is a Matrix-compatible channel plugin. OpenClaw connects as a Matrix **user** on your DeJoy homeserver. You need a DeJoy/Matrix account for the bot; once configured, you can DM the bot or invite it to rooms.

Status: supported via plugin (@vector-im/matrix-bot-sdk). Direct messages, rooms, threads, media, reactions, and E2EE (optional).

## Plugin required

DeJoy ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/dejoy
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/dejoy
```

If you choose DeJoy during configure/onboarding and a git checkout is detected, OpenClaw will offer the local install path automatically.

Details: [Plugins](/tools/plugin)

## Setup

1. **Install the DeJoy plugin** (see above).
2. **Homeserver URL** — DeJoy requires a homeserver URL (your Matrix/DeJoy server).
3. **Credentials** — Use either:
   - **Access token (recommended):** user ID is fetched automatically via `/whoami`. No need to set user ID.
   - **Password:** logs in via the Matrix login API; OpenClaw stores the token. You must set user ID (`@user:server`) and password.
4. **Environment variables** (optional): `DEJOY_HOMESERVER`, `DEJOY_USER_ID`, `DEJOY_ACCESS_TOKEN`, `DEJOY_PASSWORD`. If set, onboarding can use them; config takes precedence when both are present.
5. **Restart the gateway** (or finish onboarding), then start a DM or invite the bot to a room from your DeJoy/Matrix client.

Minimal config (access token; user ID auto-fetched):

```json5
{
  channels: {
    dejoy: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

Password-based config (user ID required):

```json5
{
  channels: {
    dejoy: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: "your-password",
      deviceName: "OpenClaw Gateway",
      dm: { policy: "pairing" },
    },
  },
}
```

## Encryption (E2EE)

End-to-end encryption is supported. Enable with `channels.dejoy.encryption: true`. On first connection, verify the device in your DeJoy/Matrix client to enable key sharing.

## Access control (DMs and rooms)

- **DMs:** Default `channels.dejoy.dm.policy = "pairing"`. Use `channels.dejoy.dm.allowFrom` with full Matrix user IDs (`@user:server`) for allowlist; use `policy: "open"` and `allowFrom: ["*"]` for open DMs.
- **Rooms:** Default `channels.dejoy.groupPolicy = "allowlist"`. List rooms in `channels.dejoy.groups` (room IDs or aliases). Set `groupPolicy: "open"` to allow any room (mention-gated), or `"disabled"` to allow none.

## Configuration reference

- `channels.dejoy.enabled` — enable/disable the channel.
- `channels.dejoy.homeserver` — homeserver URL (required).
- `channels.dejoy.userId` — full user ID `@user:server` (required when using password; optional with access token).
- `channels.dejoy.accessToken` — access token (recommended).
- `channels.dejoy.password` — password (OpenClaw logs in and stores token).
- `channels.dejoy.deviceName` — device display name.
- `channels.dejoy.encryption` — enable E2EE (default: false).
- `channels.dejoy.dm.policy` — `pairing | allowlist | open | disabled` (default: pairing).
- `channels.dejoy.dm.allowFrom` — DM allowlist (full user IDs).
- `channels.dejoy.groupPolicy` — `allowlist | open | disabled` (default: allowlist).
- `channels.dejoy.groups` — room allowlist (room IDs or aliases).

Full configuration: [Configuration](/gateway/configuration)

## Troubleshooting

Run:

```bash
openclaw status
openclaw channels status --probe
openclaw doctor
```

If DMs are ignored, check `channels.dejoy.dm.policy` and pairing: `openclaw pairing list dejoy`. If room messages are ignored, check `groupPolicy` and `channels.dejoy.groups`. For more: [Channel troubleshooting](/channels/troubleshooting).
