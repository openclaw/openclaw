---
summary: "WeChat support on Linux desktop via PyWxDump bridge"
read_when:
  - Setting up WeChat on a Linux gateway host
  - Checking what the bundled WeChat channel supports
title: "WeChat Linux Desktop"
---

# WeChat Linux Desktop

Status: bundled channel for the official Linux desktop WeChat client via a local PyWxDump bridge.
Supports direct messages and groups with text, images, and files.

## Requirements

- Linux host running the official desktop WeChat client and signed in.
- X11 or Xwayland session. Pure Wayland is not supported in v1.
- A local PyWxDump checkout on the same host as the gateway.
- A readable WeChat key file and decrypted database access prepared for PyWxDump.
- `xdotool` available on the gateway host.

## Quick setup

1. Install and sign in to the Linux desktop WeChat client.
2. Prepare PyWxDump on the gateway host and confirm it can extract keys and read local chat data.
3. Configure `channels.wechat-linux`.
4. Probe the bridge:

```bash
openclaw channels status --probe
```

Minimal config:

```json5
{
  channels: {
    "wechat-linux": {
      enabled: true,
      pyWxDumpRoot: "/opt/PyWxDump",
      pythonPath: "python3",
      keyFile: "/home/user/.wx_db_keys.json",
      outputDir: "/home/user/wechat-decrypted",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: ["wxid_example123"],
      groupAllowFrom: ["wxid_example123"],
    },
  },
}
```

## What this channel does

- Watches Linux desktop WeChat chats through a Python bridge.
- Normalizes inbound messages into OpenClaw sessions and routes them to the configured agent.
- Sends final agent replies back to WeChat as text, images, or files.
- Keeps DM pairing and group mention safety behavior aligned with other OpenClaw channels.

## Access control

DMs:

- Default: `channels.wechat-linux.dmPolicy = "pairing"`.
- Unknown senders receive a pairing challenge and are blocked until approved.
- `allowFrom` entries should use stable sender ids such as `wxid_*`.
- `open` should only be used together with `allowFrom: ["*"]`.

Groups:

- Default: `channels.wechat-linux.groupPolicy = "allowlist"`.
- `groupAllowFrom` allowlists group senders by sender id, not by room id.
- Group messages are mention-gated in v1 unless the sender is issuing an authorized control command.

## Target formats

Manual sends can target:

- Direct ids: `wechat-linux:user:wxid_example123`
- Group ids: `wechat-linux:group:123456789@chatroom`
- Plain ids: `wxid_example123` or `123456789@chatroom`
- Display names: supported when the bridge can resolve them uniquely

## Capabilities

| Feature         | Status              |
| --------------- | ------------------- |
| Direct messages | Supported           |
| Groups          | Supported           |
| Text            | Supported           |
| Images          | Supported           |
| Files           | Supported           |
| Threads         | Not supported       |
| Reactions       | Not supported       |
| Voice and video | Metadata only in v1 |
| Search actions  | Not included in v1  |

## Notes

- This channel is different from the community WeChatPadPro plugin listed on [Community plugins](/plugins/community).
- The bridge needs readable local media files to attach inbound images and files. If a file cannot be materialized locally, the message still reaches the agent as text metadata.
- Outbound streaming is blocked. Only final replies are sent to WeChat.
- `windowMode` defaults to `auto`. Use `standalone` or `main` only when you need to force a specific desktop window flow.

## Configuration reference

Provider options:

- `channels.wechat-linux.enabled`: enable or disable channel startup.
- `channels.wechat-linux.pyWxDumpRoot`: path to the local PyWxDump checkout.
- `channels.wechat-linux.pythonPath`: Python executable for the bridge.
- `channels.wechat-linux.keyFile`: path to the PyWxDump key file.
- `channels.wechat-linux.dbDir`: optional override for the WeChat database directory.
- `channels.wechat-linux.outputDir`: writable directory for decrypted and extracted artifacts.
- `channels.wechat-linux.display`: optional `DISPLAY` override for GUI send flows.
- `channels.wechat-linux.xauthority`: optional `XAUTHORITY` override for GUI send flows.
- `channels.wechat-linux.windowClass`: desktop window class to target.
- `channels.wechat-linux.windowMode`: `auto | standalone | main`.
- `channels.wechat-linux.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.wechat-linux.allowFrom`: DM allowlist by sender id.
- `channels.wechat-linux.groupPolicy`: `allowlist | open | disabled`.
- `channels.wechat-linux.groupAllowFrom`: group sender allowlist by sender id.
- `channels.wechat-linux.mentionPatterns`: mention aliases for group gating.
- `channels.wechat-linux.textChunkLimit`: outbound text chunk limit.
- `channels.wechat-linux.blockStreaming`: disable block streaming for this channel.
- `channels.wechat-linux.mediaMaxMb`: inbound and outbound media cap in MB.
- `channels.wechat-linux.accounts.<id>.*`: per-account overrides for all fields above.
