---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Signal support via signal-cli (JSON-RPC + SSE), setup, and number model"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up Signal support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging Signal send/receive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Signal"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Signal (signal-cli)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: external CLI integration. Gateway talks to `signal-cli` over HTTP JSON-RPC + SSE.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup (beginner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Use a **separate Signal number** for the bot (recommended).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Install `signal-cli` (Java required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Link the bot device and start the daemon:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `signal-cli link -n "OpenClaw"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Configure OpenClaw and start the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    signal: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      account: "+15551234567",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cliPath: "signal-cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["+15557654321"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal channel via `signal-cli` (not embedded libsignal).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deterministic routing: replies always go back to Signal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DMs share the agent's main session; groups are isolated (`agent:<agentId>:signal:group:<groupId>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config writes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, Signal is allowed to write config updates triggered by `/config set|unset` (requires `commands.config: true`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Disable with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: { signal: { configWrites: false } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The number model (important)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The gateway connects to a **Signal device** (the `signal-cli` account).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you run the bot on **your personal Signal account**, it will ignore your own messages (loop protection).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For "I text the bot and it replies," use a **separate bot number**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup (fast path)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install `signal-cli` (Java required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Link a bot account:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `signal-cli link -n "OpenClaw"` then scan the QR in Signal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Configure Signal and start the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    signal: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      account: "+15551234567",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cliPath: "signal-cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["+15557654321"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account support: use `channels.signal.accounts` with per-account config and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## External daemon mode (httpUrl)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to manage `signal-cli` yourself (slow JVM cold starts, container init, or shared CPUs), run the daemon separately and point OpenClaw at it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    signal: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      httpUrl: "http://127.0.0.1:8080",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      autoStart: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This skips auto-spawn and the startup wait inside OpenClaw. For slow starts when auto-spawning, set `channels.signal.startupTimeoutMs`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control (DMs + groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
DMs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.signal.dmPolicy = "pairing"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approve via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing list signal`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing approve signal <CODE>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing is the default token exchange for Signal DMs. Details: [Pairing](/channels/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UUID-only senders (from `sourceUuid`) are stored as `uuid:<id>` in `channels.signal.allowFrom`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Groups:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.groupPolicy = open | allowlist | disabled`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.groupAllowFrom` controls who can trigger in groups when `allowlist` is set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works (behavior)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `signal-cli` runs as a daemon; the gateway reads events via SSE.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Inbound messages are normalized into the shared channel envelope.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replies always route back to the same number or group.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Media + limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Outbound text is chunked to `channels.signal.textChunkLimit` (default 4000).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional newline chunking: set `channels.signal.chunkMode="newline"` to split on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Attachments supported (base64 fetched from `signal-cli`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default media cap: `channels.signal.mediaMaxMb` (default 8).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `channels.signal.ignoreAttachments` to skip downloading media.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group history context uses `channels.signal.historyLimit` (or `channels.signal.accounts.*.historyLimit`), falling back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Typing + read receipts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Typing indicators**: OpenClaw sends typing signals via `signal-cli sendTyping` and refreshes them while a reply is running.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Read receipts**: when `channels.signal.sendReadReceipts` is true, OpenClaw forwards read receipts for allowed DMs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal-cli does not expose read receipts for groups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reactions (message tool)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `message action=react` with `channel=signal`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Targets: sender E.164 or UUID (use `uuid:<id>` from pairing output; bare UUID works too).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messageId` is the Signal timestamp for the message you’re reacting to.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group reactions require `targetAuthor` or `targetAuthorUuid`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.actions.reactions`: enable/disable reaction actions (default true).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `off`/`ack` disables agent reactions (message tool `react` will error).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `minimal`/`extensive` enables agent reactions and sets the guidance level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-account overrides: `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Delivery targets (CLI/cron)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DMs: `signal:+15551234567` (or plain E.164).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UUID DMs: `uuid:<id>` (or bare UUID).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Groups: `signal:group:<groupId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Usernames: `username:<name>` (if supported by your Signal account).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run this ladder first:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then confirm DM pairing state if needed:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing list signal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common failures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Daemon reachable but no replies: verify account/daemon settings (`httpUrl`, `account`) and receive mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DMs ignored: sender is pending pairing approval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group messages ignored: group sender/mention gating blocks delivery.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For triage flow: [/channels/troubleshooting](/channels/troubleshooting).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration reference (Signal)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full configuration: [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.enabled`: enable/disable channel startup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.account`: E.164 for the bot account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.cliPath`: path to `signal-cli`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.httpUrl`: full daemon URL (overrides host/port).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.httpHost`, `channels.signal.httpPort`: daemon bind (default 127.0.0.1:8080).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.autoStart`: auto-spawn daemon (default true if `httpUrl` unset).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.startupTimeoutMs`: startup wait timeout in ms (cap 120000).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.receiveMode`: `on-start | manual`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.ignoreAttachments`: skip attachment downloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.ignoreStories`: ignore stories from the daemon.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.sendReadReceipts`: forward read receipts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.allowFrom`: DM allowlist (E.164 or `uuid:<id>`). `open` requires `"*"`. Signal has no usernames; use phone/UUID ids.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (default: allowlist).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.groupAllowFrom`: group sender allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.historyLimit`: max group messages to include as context (0 disables).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.dmHistoryLimit`: DM history limit in user turns. Per-user overrides: `channels.signal.dms["<phone_or_uuid>"].historyLimit`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.textChunkLimit`: outbound chunk size (chars).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.signal.mediaMaxMb`: inbound/outbound media cap (MB).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related global options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].groupChat.mentionPatterns` (Signal does not support native mentions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messages.groupChat.mentionPatterns` (global fallback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messages.responsePrefix`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
