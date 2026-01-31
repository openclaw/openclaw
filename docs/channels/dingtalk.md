---
summary: "DingTalk channel support status, capabilities, and configuration"
read_when:
  - Working on DingTalk channel features
---
# DingTalk (plugin)

Updated: 2026-01-31

Status: Stream mode implementation in progress. Uses WebSocket connections via the official `dingtalk-stream` SDK.

## Plugin required

DingTalk ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):
```bash
openclaw plugins install @openclaw/dingtalk
```

Local checkout (when running from a git repo):
```bash
openclaw plugins install ./extensions/dingtalk
```

If you choose DingTalk during configure/onboarding and a git checkout is detected,
OpenClaw will offer the local install path automatically.

Details: [Plugins](/plugin)

## Quick setup

1) Install the DingTalk plugin.
2) Create a **DingTalk Bot** in the DingTalk Open Platform (App Key + App Secret).
3) Configure OpenClaw with those credentials.
4) Start the gateway (stream mode doesn't require a public URL/webhook).

Minimal config:
```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      appKey: "<APP_KEY>",
      appSecret: "<APP_SECRET>"
    }
  }
}
```

Note: group chats are blocked by default (`channels.dingtalk.groupPolicy: "allowlist"`). To allow group replies, set `channels.dingtalk.groupAllowFrom` (or use `groupPolicy: "open"` to allow any member, mention-gated).

**📖 For detailed setup instructions, see [DingTalk Setup Guide](/channels/dingtalk-setup).**

## Goals

- Talk to OpenClaw via DingTalk DMs or group chats.
- Keep routing deterministic: replies always go back to the channel they arrived on.
- Default to safe channel behavior (mentions required unless configured otherwise).
- Use stream mode (WebSocket) - no public URL/webhook needed.

## Stream Mode

DingTalk uses **stream mode** via WebSocket connections. This means:
- No public URL or webhook endpoint required
- Direct WebSocket connection to DingTalk's stream API
- Uses the official `dingtalk-stream` SDK

## Access control (DMs + groups)

**DM access**
- Default: `channels.dingtalk.dmPolicy = "pairing"`. Unknown senders are ignored until approved.
- `channels.dingtalk.allowFrom` accepts user IDs.

**Group access**
- Default: `channels.dingtalk.groupPolicy = "allowlist"` (blocked unless you add `groupAllowFrom`). Use `channels.defaults.groupPolicy` to override the default when unset.
- `channels.dingtalk.groupAllowFrom` controls which senders can trigger in group chats (falls back to `channels.dingtalk.allowFrom`).
- Set `groupPolicy: "open"` to allow any member (still mention‑gated by default).
- To allow **no groups**, set `channels.dingtalk.groupPolicy: "disabled"`.

Example:
```json5
{
  channels: {
    dingtalk: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user123"]
    }
  }
}
```

**Group-level config**
- Scope group replies by listing groups under `channels.dingtalk.groups`.
- Each group can override `requireMention`, `tools`, and `toolsBySender`.
- Per-channel overrides are also supported within groups.

Example:
```json5
{
  channels: {
    dingtalk: {
      groups: {
        "groupId123": {
          requireMention: true,
          channels: {
            "channelId456": {
              requireMention: false
            }
          }
        }
      }
    }
  }
}
```

## Configuration reference

### Basic settings

- `enabled` (boolean, default: `true`): Enable/disable the DingTalk provider.
- `appKey` (string): DingTalk App Key from the Open Platform.
- `appSecret` (string): DingTalk App Secret from the Open Platform.

### Access control

- `dmPolicy` (`"pairing"` | `"open"`, default: `"pairing"`): DM access policy.
- `allowFrom` (string[]): Allowlist for DM senders (user IDs).
- `groupAllowFrom` (string[]): Allowlist for group/channel senders (user IDs).
- `groupPolicy` (`"open"` | `"disabled"` | `"allowlist"`, default: `"allowlist"`): Group message handling policy.

### Message settings

- `requireMention` (boolean, default: `true`): Require @mention to respond in groups/channels.
- `textChunkLimit` (number, default: `4000`): Outbound text chunk size in characters.
- `chunkMode` (`"length"` | `"newline"`, default: `"length"`): Chunking mode.
- `historyLimit` (number, default: `0`): Max group/channel messages to keep as history context (0 disables).
- `dmHistoryLimit` (number): Max DM turns to keep as history context.

### Media

- `mediaMaxMb` (number, default: `20`): Max media size in MB.
- `mediaAllowHosts` (string[]): Allowed host suffixes for inbound attachment downloads. Use `["*"]` to allow any host (not recommended).

### Advanced

- `configWrites` (boolean, default: `true`): Allow channel-initiated config writes.
- `capabilities` (string[]): Optional provider capability tags.
- `markdown` (object): Markdown formatting overrides.
- `blockStreamingCoalesce` (object): Merge streamed block replies before sending.
- `dms` (object): Per-DM config overrides keyed by user ID.
- `groups` (object): Per-group config keyed by group ID.
- `heartbeat` (object): Heartbeat visibility settings.

## Environment variables

You can also set credentials via environment variables:
- `DINGTALK_APP_KEY`: App Key
- `DINGTALK_APP_SECRET`: App Secret

## Implementation status

⚠️ **Work in progress**: The DingTalk extension is currently being implemented. Core structure and configuration are in place, but the following features need completion:

- [ ] Complete DingTalk Stream SDK integration in `monitor.ts`
- [ ] Implement message sending via Stream SDK in `send.ts`
- [ ] Implement probe functionality for credential validation
- [ ] Add group allowlist/policy checking with @mention requirements
- [ ] Implement DM pairing flow for user authorization
- [ ] Add media handling (attachments, images)
- [ ] Add error handling and reconnection logic

## Reference

- DingTalk Stream SDK: https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs
- DingTalk Open Platform: https://open.dingtalk.com/
