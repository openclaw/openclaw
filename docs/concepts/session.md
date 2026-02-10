---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Session management rules, keys, and persistence for chats"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Modifying session handling or storage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Session Management"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Session Management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw treats **one direct-chat session per agent** as primary. Direct chats collapse to `agent:<agentId>:<mainKey>` (default `main`), while group/channel chats get their own keys. `session.mainKey` is honored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `session.dmScope` to control how **direct messages** are grouped:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `main` (default): all DMs share the main session for continuity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `per-peer`: isolate by sender id across channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `per-channel-peer`: isolate by channel + sender (recommended for multi-user inboxes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `per-account-channel-peer`: isolate by account + channel + sender (recommended for multi-account inboxes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Use `session.identityLinks` to map provider-prefixed peer ids to a canonical identity so the same person shares a DM session across channels when using `per-peer`, `per-channel-peer`, or `per-account-channel-peer`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Secure DM mode (recommended for multi-user setups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Security Warning:** If your agent can receive DMs from **multiple people**, you should strongly consider enabling secure DM mode. Without it, all users share the same conversation context, which can leak private information between users.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example of the problem with default settings:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Alice (`<SENDER_A>`) messages your agent about a private topic (for example, a medical appointment)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bob (`<SENDER_B>`) messages your agent asking "What were we talking about?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Because both DMs share the same session, the model may answer Bob using Alice's prior context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**The fix:** Set `dmScope` to isolate sessions per user:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// ~/.openclaw/openclaw.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // Secure DM mode: isolate DM context per channel + sender.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    dmScope: "per-channel-peer",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**When to enable this:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You have pairing approvals for more than one sender（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You use a DM allowlist with multiple entries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You set `dmPolicy: "open"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multiple phone numbers or accounts can message your agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default is `dmScope: "main"` for continuity (all DMs share the main session). This is fine for single-user setups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For multi-account inboxes on the same channel, prefer `per-account-channel-peer`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the same person contacts you on multiple channels, use `session.identityLinks` to collapse their DM sessions into one canonical identity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You can verify your DM settings with `openclaw security audit` (see [security](/cli/security)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway is the source of truth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All session state is **owned by the gateway** (the “master” OpenClaw). UI clients (macOS app, WebChat, etc.) must query the gateway for session lists and token counts instead of reading local files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- In **remote mode**, the session store you care about lives on the remote gateway host, not your Mac.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Token counts shown in UIs come from the gateway’s store fields (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Clients do not parse JSONL transcripts to “fix up” totals.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where state lives（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On the **gateway host**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Store file: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (per agent).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Transcripts: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (Telegram topic sessions use `.../<SessionId>-topic-<threadId>.jsonl`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The store is a map `sessionKey -> { sessionId, updatedAt, ... }`. Deleting entries is safe; they are recreated on demand.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group entries may include `displayName`, `channel`, `subject`, `room`, and `space` to label sessions in UIs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session entries include `origin` metadata (label + routing hints) so UIs can explain where a session came from.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw does **not** read legacy Pi/Tau session folders.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session pruning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw trims **old tool results** from the in-memory context right before LLM calls by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This does **not** rewrite JSONL history. See [/concepts/session-pruning](/concepts/session-pruning).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pre-compaction memory flush（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a session nears auto-compaction, OpenClaw can run a **silent memory flush**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
turn that reminds the model to write durable notes to disk. This only runs when（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the workspace is writable. See [Memory](/concepts/memory) and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Compaction](/concepts/compaction).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Mapping transports → session keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct chats follow `session.dmScope` (default `main`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `main`: `agent:<agentId>:<mainKey>` (continuity across devices/channels).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Multiple phone numbers and channels can map to the same agent main key; they act as transports into one conversation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId defaults to `default`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If `session.identityLinks` matches a provider-prefixed peer id (for example `telegram:123`), the canonical key replaces `<peerId>` so the same person shares a session across channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group chats isolate state: `agent:<agentId>:<channel>:group:<id>` (rooms/channels use `agent:<agentId>:<channel>:channel:<id>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Telegram forum topics append `:topic:<threadId>` to the group id for isolation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Legacy `group:<id>` keys are still recognized for migration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Inbound contexts may still use `group:<id>`; the channel is inferred from `Provider` and normalized to the canonical `agent:<agentId>:<channel>:group:<id>` form.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Other sources:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Cron jobs: `cron:<job.id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Webhooks: `hook:<uuid>` (unless explicitly set by the hook)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Node runs: `node-<nodeId>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Lifecycle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reset policy: sessions are reused until they expire, and expiry is evaluated on the next inbound message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Daily reset: defaults to **4:00 AM local time on the gateway host**. A session is stale once its last update is earlier than the most recent daily reset time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Idle reset (optional): `idleMinutes` adds a sliding idle window. When both daily and idle resets are configured, **whichever expires first** forces a new session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Legacy idle-only: if you set `session.idleMinutes` without any `session.reset`/`resetByType` config, OpenClaw stays in idle-only mode for backward compatibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-type overrides (optional): `resetByType` lets you override the policy for `direct`, `group`, and `thread` sessions (thread = Slack/Discord threads, Telegram topics, Matrix threads when provided by the connector).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-channel overrides (optional): `resetByChannel` overrides the reset policy for a channel (applies to all session types for that channel and takes precedence over `reset`/`resetByType`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reset triggers: exact `/new` or `/reset` (plus any extras in `resetTriggers`) start a fresh session id and pass the remainder of the message through. `/new <model>` accepts a model alias, `provider/model`, or provider name (fuzzy match) to set the new session model. If `/new` or `/reset` is sent alone, OpenClaw runs a short “hello” greeting turn to confirm the reset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Manual reset: delete specific keys from the store or remove the JSONL transcript; the next message recreates them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Isolated cron jobs always mint a fresh `sessionId` per run (no idle reuse).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Send policy (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Block delivery for specific session types without listing individual ids.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sendPolicy: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      rules: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { action: "deny", match: { channel: "discord", chatType: "group" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { action: "deny", match: { keyPrefix: "cron:" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      default: "allow",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Runtime override (owner only):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/send on` → allow for this session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/send off` → deny for this session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/send inherit` → clear override and use config rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Send these as standalone messages so they register.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration (optional rename example)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// ~/.openclaw/openclaw.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    scope: "per-sender", // keep group keys separate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    identityLinks: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      alice: ["telegram:123456789", "discord:987654321012345678"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    reset: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // Defaults: mode=daily, atHour=4 (gateway host local time).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // If you also set idleMinutes, whichever expires first wins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mode: "daily",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      atHour: 4,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      idleMinutes: 120,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    resetByType: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      thread: { mode: "daily", atHour: 4 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      direct: { mode: "idle", idleMinutes: 240 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      group: { mode: "idle", idleMinutes: 120 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    resetByChannel: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      discord: { mode: "idle", idleMinutes: 10080 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    resetTriggers: ["/new", "/reset"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mainKey: "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inspecting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status` — shows store path and recent sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw sessions --json` — dumps every entry (filter with `--active <minutes>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway call sessions.list --params '{}'` — fetch sessions from the running gateway (use `--url`/`--token` for remote gateway access).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send `/status` as a standalone message in chat to see whether the agent is reachable, how much of the session context is used, current thinking/verbose toggles, and when your WhatsApp web creds were last refreshed (helps spot relink needs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send `/context list` or `/context detail` to see what’s in the system prompt and injected workspace files (and the biggest context contributors).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send `/stop` as a standalone message to abort the current run, clear queued followups for that session, and stop any sub-agent runs spawned from it (the reply includes the stopped count).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send `/compact` (optional instructions) as a standalone message to summarize older context and free up window space. See [/concepts/compaction](/concepts/compaction).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- JSONL transcripts can be opened directly to review full turns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tips（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep the primary key dedicated to 1:1 traffic; let groups keep their own keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When automating cleanup, delete individual keys instead of the whole store to preserve context elsewhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session origin metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each session entry records where it came from (best-effort) in `origin`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `label`: human label (resolved from conversation label + group subject/channel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `provider`: normalized channel id (including extensions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `from`/`to`: raw routing ids from the inbound envelope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `accountId`: provider account id (when multi-account)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `threadId`: thread/topic id when the channel supports it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The origin fields are populated for direct messages, channels, and groups. If a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  connector only updates delivery routing (for example, to keep a DM main session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  fresh), it should still provide inbound context so the session keeps its（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  explainer metadata. Extensions can do this by sending `ConversationLabel`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `GroupSubject`, `GroupChannel`, `GroupSpace`, and `SenderName` in the inbound（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context and calling `recordSessionMetaFromInbound` (or passing the same context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  to `updateLastRoute`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
