---
summary: "Zalo personal account support via native zca-js (QR login), capabilities, and configuration"
read_when:
  - Setting up Zalo Personal for OpenClaw
  - Debugging Zalo Personal login or message flow
title: "Zalo Personal"
---

# Zalo Personal (unofficial)

Status: experimental. This integration automates a **personal Zalo account** via native `zca-js` inside OpenClaw.

> **Warning:** This is an unofficial integration and may result in account suspension/ban. Use at your own risk.

## Plugin required

Zalo Personal ships as a plugin and is not bundled with the core install.

- Install via CLI: `openclaw plugins install @openclaw/zalouser`
- Or from a source checkout: `openclaw plugins install ./extensions/zalouser`
- Details: [Plugins](/tools/plugin)

No external `zca`/`openzca` CLI binary is required.

## Quick setup (beginner)

1. Install the plugin (see above).
2. Login (QR, on the Gateway machine):
   - `openclaw channels login --channel zalouser`
   - Scan the QR code with the Zalo mobile app.
3. Enable the channel:

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

4. Restart the Gateway (or finish onboarding).
5. DM access defaults to pairing; approve the pairing code on first contact.

## What it is

- Runs entirely in-process via `zca-js`.
- Uses native event listeners to receive inbound messages.
- Sends replies directly through the JS API (text/media/link).
- Designed for “personal account” use cases where Zalo Bot API is not available.

## Naming

Channel id is `zalouser` to make it explicit this automates a **personal Zalo user account** (unofficial). We keep `zalo` reserved for a potential future official Zalo API integration.

## Finding IDs (directory)

Use the directory CLI to discover peers/groups and their IDs:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Limits

- Outbound text is chunked to ~2000 characters (Zalo client limits).
- Streaming is blocked by default.

## Access control (DMs)

`channels.zalouser.dmPolicy` supports: `pairing | allowlist | open | disabled` (default: `pairing`).

`channels.zalouser.allowFrom` accepts user IDs or names. During onboarding, names are resolved to IDs using the plugin's in-process contact lookup.

Approve via:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Group access (optional)

- Default: `channels.zalouser.groupPolicy = "open"` (groups allowed). Use `channels.defaults.groupPolicy` to override the default when unset.
- Restrict to an allowlist with:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (keys are group IDs or names)
- Block all groups: `channels.zalouser.groupPolicy = "disabled"`.
- The configure wizard can prompt for group allowlists.
- On startup, OpenClaw resolves group/user names in allowlists to IDs and logs the mapping; unresolved entries are kept as typed.

Example:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Multi-account

Accounts map to `zalouser` profiles in OpenClaw state. Example:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Troubleshooting

**Login doesn't stick:**

- `openclaw channels status --probe`
- Re-login: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`

**Allowlist/group name didn't resolve:**

- Use numeric IDs in `allowFrom`/`groups`, or exact friend/group names.

**Upgraded from old CLI-based setup:**

- Remove any old external `zca` process assumptions.
- The channel now runs fully in OpenClaw without external CLI binaries.
