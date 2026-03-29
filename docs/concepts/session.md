---
summary: "How OpenClaw manages sessions -- routing, isolation, lifecycle, and maintenance"
read_when:
  - You want to understand session keys and routing
  - You want to configure DM isolation or multi-user setups
  - You want to tune session lifecycle or maintenance
title: "Session Management"
---

# Session Management

OpenClaw manages conversations through **sessions**. Each session has a key
(which conversation bucket it belongs to), an ID (which transcript file
continues it), and metadata tracked in a session store.

## How sessions are routed

Every inbound message is mapped to a **session key** that determines which
conversation it joins:

| Source          | Session key pattern                      | Behavior                              |
| --------------- | ---------------------------------------- | ------------------------------------- |
| Direct messages | `agent:<agentId>:<mainKey>`              | Shared by default (`dmScope: "main"`) |
| Group chats     | `agent:<agentId>:<channel>:group:<id>`   | Isolated per group                    |
| Rooms/channels  | `agent:<agentId>:<channel>:channel:<id>` | Isolated per room                     |
| Cron jobs       | `cron:<job.id>`                          | Fresh session per run                 |
| Webhooks        | `hook:<uuid>`                            | Unless explicitly overridden          |
| Node runs       | `node-<nodeId>`                          | Unless explicitly overridden          |

Telegram forum topics append `:topic:<threadId>` for per-topic isolation.

## DM scope and isolation

By default, all direct messages share one session (`dmScope: "main"`) for
continuity across devices and channels. This works well for single-user setups,
but can leak context when multiple people message your agent.

### Secure DM mode

<Warning>
If your agent receives DMs from multiple people, you should enable DM isolation.
Without it, all users share the same conversation context.
</Warning>

**The problem:** Alice messages about a private topic. Bob asks "What were we
talking about?" Because both share a session, the model may answer Bob using
Alice's context.

**The fix:**

```json5
{
  session: {
    dmScope: "per-channel-peer",
  },
}
```

### DM scope options

| Value                      | Key pattern                                        | Best for                             |
| -------------------------- | -------------------------------------------------- | ------------------------------------ |
| `main` (default)           | `agent:<id>:main`                                  | Single-user, cross-device continuity |
| `per-peer`                 | `agent:<id>:direct:<peerId>`                       | Multi-user, cross-channel identity   |
| `per-channel-peer`         | `agent:<id>:<channel>:direct:<peerId>`             | Multi-user inboxes (recommended)     |
| `per-account-channel-peer` | `agent:<id>:<channel>:<accountId>:direct:<peerId>` | Multi-account inboxes                |

### Cross-channel identity linking

When using `per-peer` or `per-channel-peer`, the same person messaging from
different channels gets separate sessions. Use `session.identityLinks` to
collapse them:

```json5
{
  session: {
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
  },
}
```

The canonical key replaces `<peerId>` so Alice shares one session across
channels.

**When to enable DM isolation:**

- Pairing approvals for more than one sender
- DM allowlist with multiple entries
- `dmPolicy: "open"`
- Multiple phone numbers or accounts can message the agent

Verify settings with `openclaw security audit` (see [security](/cli/security)).
Local CLI onboarding writes `per-channel-peer` by default when unset.

## Session lifecycle

### Resets

Sessions are reused until they expire. Expiry is evaluated on the next inbound
message:

- **Daily reset** (default) -- 4:00 AM local time on the gateway host. A
  session is stale once its last update is before the most recent reset time.
- **Idle reset** (optional) -- `idleMinutes` adds a sliding idle window.
- **Combined** -- when both are configured, whichever expires first forces a new
  session.

Override per session type or channel:

```json5
{
  session: {
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      direct: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
  },
}
```

### Manual resets

- `/new` or `/reset` starts a fresh session. The remainder of the message is
  passed through.
- `/new <model>` accepts a model alias, `provider/model`, or provider name
  (fuzzy match) to set the session model.
- If sent alone, OpenClaw runs a short greeting turn to confirm the reset.
- Custom triggers: add to `resetTriggers` array.
- Delete specific keys from the store or remove the JSONL transcript; the next
  message recreates them.
- Isolated cron jobs always mint a fresh `sessionId` per run.

## Where state lives

All session state is **owned by the gateway**. UI clients (macOS app, WebChat,
TUI) query the gateway for session lists and token counts.

In remote mode, the session store lives on the remote gateway host, not your
local machine.

### Storage

| Artifact      | Path                                                      | Purpose                           |
| ------------- | --------------------------------------------------------- | --------------------------------- |
| Session store | `~/.openclaw/agents/<agentId>/sessions/sessions.json`     | Key-value map of session metadata |
| Transcripts   | `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl` | Append-only conversation history  |

The store maps `sessionKey -> { sessionId, updatedAt, ... }`. Deleting entries
is safe; they are recreated on demand. Group entries may include `displayName`,
`channel`, `subject`, `room`, and `space` for UI labeling.

Telegram topic sessions use `.../<sessionId>-topic-<threadId>.jsonl`.

## Session maintenance

OpenClaw keeps the session store and transcripts bounded over time.

### Defaults

| Setting                 | Default             | Description                                                     |
| ----------------------- | ------------------- | --------------------------------------------------------------- |
| `mode`                  | `warn`              | `warn` reports what would be evicted; `enforce` applies cleanup |
| `pruneAfter`            | `30d`               | Stale-entry age cutoff                                          |
| `maxEntries`            | `500`               | Cap entries in sessions.json                                    |
| `rotateBytes`           | `10mb`              | Rotate sessions.json when oversized                             |
| `resetArchiveRetention` | `30d`               | Retention for reset archives                                    |
| `maxDiskBytes`          | unset               | Optional sessions-directory budget                              |
| `highWaterBytes`        | 80% of maxDiskBytes | Target after cleanup                                            |

### Enforcement order (`mode: "enforce"`)

1. Prune stale entries older than `pruneAfter`.
2. Cap entry count to `maxEntries` (oldest first).
3. Archive transcript files for removed entries.
4. Purge old reset/deleted archives by retention policy.
5. Rotate `sessions.json` when it exceeds `rotateBytes`.
6. If `maxDiskBytes` is set, enforce disk budget toward `highWaterBytes`.

### Configuration examples

Conservative enforce policy:

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "45d",
      maxEntries: 800,
      rotateBytes: "20mb",
      resetArchiveRetention: "14d",
    },
  },
}
```

Hard disk budget:

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      maxDiskBytes: "1gb",
      highWaterBytes: "800mb",
    },
  },
}
```

Preview or force from CLI:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

### Performance note

Large session stores can increase write-path latency. To keep things fast:

- Use `mode: "enforce"` in production.
- Set both time and count limits (`pruneAfter` + `maxEntries`).
- Set `maxDiskBytes` + `highWaterBytes` for hard upper bounds.
- Run `openclaw sessions cleanup --dry-run --json` after config changes to
  preview impact.

## Send policy

Block delivery for specific session types without listing individual IDs:

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
        { action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } },
      ],
      default: "allow",
    },
  },
}
```

Runtime override (owner only):

- `/send on` -- allow for this session.
- `/send off` -- deny for this session.
- `/send inherit` -- clear override and use config rules.

## Inspecting sessions

| Method                               | What it shows                                              |
| ------------------------------------ | ---------------------------------------------------------- |
| `openclaw status`                    | Store path, recent sessions                                |
| `openclaw sessions --json`           | All entries (filter with `--active <minutes>`)             |
| `/status` in chat                    | Reachability, context usage, toggles, cred freshness       |
| `/context list` or `/context detail` | System prompt contents, biggest context contributors       |
| `/stop` in chat                      | Abort current run, clear queued followups, stop sub-agents |

JSONL transcripts can be opened directly to review full turns.

## Session origin metadata

Each session entry records where it came from (best-effort) in `origin`:

- `label` -- human label (from conversation label + group subject/channel).
- `provider` -- normalized channel ID (including extensions).
- `from` / `to` -- raw routing IDs from the inbound envelope.
- `accountId` -- provider account ID (multi-account).
- `threadId` -- thread/topic ID when supported.

Extensions populate these by sending `ConversationLabel`, `GroupSubject`,
`GroupChannel`, `GroupSpace`, and `SenderName` in the inbound context.

## Tips

- Keep the primary key dedicated to 1:1 traffic; let groups keep their own
  keys.
- When automating cleanup, delete individual keys instead of the whole store to
  preserve context elsewhere.
- Related: [Session Pruning](/concepts/session-pruning),
  [Compaction](/concepts/compaction),
  [Session Tools](/concepts/session-tool),
  [Session Management Deep Dive](/reference/session-management-compaction).
