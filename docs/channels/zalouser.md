---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Zalo personal account support via zca-cli (QR login), capabilities, and configuration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up Zalo Personal for OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging Zalo Personal login or message flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Zalo Personal"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Zalo Personal (unofficial)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: experimental. This integration automates a **personal Zalo account** via `zca-cli`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Warning:** This is an unofficial integration and may result in account suspension/ban. Use at your own risk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Zalo Personal ships as a plugin and is not bundled with the core install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install via CLI: `openclaw plugins install @openclaw/zalouser`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Or from a source checkout: `openclaw plugins install ./extensions/zalouser`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Details: [Plugins](/tools/plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prerequisite: zca-cli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway machine must have the `zca` binary available in `PATH`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify: `zca --version`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If missing, install zca-cli (see `extensions/zalouser/README.md` or the upstream zca-cli docs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup (beginner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install the plugin (see above).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Login (QR, on the Gateway machine):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `openclaw channels login --channel zalouser`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Scan the QR code in the terminal with the Zalo mobile app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Enable the channel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    zalouser: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Restart the Gateway (or finish onboarding).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. DM access defaults to pairing; approve the pairing code on first contact.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses `zca listen` to receive inbound messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses `zca msg ...` to send replies (text/media/link).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Designed for “personal account” use cases where Zalo Bot API is not available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Naming（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Channel id is `zalouser` to make it explicit this automates a **personal Zalo user account** (unofficial). We keep `zalo` reserved for a potential future official Zalo API integration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Finding IDs (directory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the directory CLI to discover peers/groups and their IDs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory self --channel zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory peers list --channel zalouser --query "name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory groups list --channel zalouser --query "work"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Outbound text is chunked to ~2000 characters (Zalo client limits).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Streaming is blocked by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control (DMs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`channels.zalouser.dmPolicy` supports: `pairing | allowlist | open | disabled` (default: `pairing`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`channels.zalouser.allowFrom` accepts user IDs or names. The wizard resolves names to IDs via `zca friend find` when available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Approve via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw pairing list zalouser`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw pairing approve zalouser <code>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Group access (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.zalouser.groupPolicy = "open"` (groups allowed). Use `channels.defaults.groupPolicy` to override the default when unset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Restrict to an allowlist with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.zalouser.groupPolicy = "allowlist"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.zalouser.groups` (keys are group IDs or names)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Block all groups: `channels.zalouser.groupPolicy = "disabled"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The configure wizard can prompt for group allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On startup, OpenClaw resolves group/user names in allowlists to IDs and logs the mapping; unresolved entries are kept as typed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    zalouser: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "123456789": { allow: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "Work Chat": { allow: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Multi-account（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Accounts map to zca profiles. Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    zalouser: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      defaultAccount: "default",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        work: { enabled: true, profile: "work" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**`zca` not found:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install zca-cli and ensure it’s on `PATH` for the Gateway process.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Login doesn’t stick:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw channels status --probe`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Re-login: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
