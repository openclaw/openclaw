---
summary: "How OpenClaw manages conversation sessions"
read_when:
  - You want to understand session routing and isolation
  - You want to configure DM scope for multi-user setups
title: "Session Management"
---

# Session Management

OpenClaw organizes conversations into **sessions**. Each message is routed to a
session based on where it came from -- DMs, group chats, cron jobs, etc.

## How messages are routed

| Source          | Behavior                  |
| --------------- | ------------------------- |
| Direct messages | Shared session by default |
| Group chats     | Isolated per group        |
| Rooms/channels  | Isolated per room         |
| Cron jobs       | Fresh session per run     |
| Webhooks        | Isolated per hook         |

## DM isolation

By default, all DMs share one session for continuity. This is fine for
single-user setups.

<Warning>
If multiple people can message your agent, enable DM isolation. Without it, all
users share the same conversation context -- Alice's private messages would be
visible to Bob.
</Warning>

**The fix:**

```json5
{
  session: {
    dmScope: "per-channel-peer", // isolate by channel + sender
  },
}
```

Other options:

- `main` (default) -- all DMs share one session.
- `per-peer` -- isolate by sender (across channels).
- `per-channel-peer` -- isolate by channel + sender (recommended).
- `per-account-channel-peer` -- isolate by account + channel + sender.

<Tip>
If the same person contacts you from multiple channels, use
`session.identityLinks` to link their identities so they share one session.
</Tip>

Verify your setup with `openclaw security audit`.

## Session lifecycle

Sessions are reused until they expire:

- **Daily reset** (default) -- new session at 4:00 AM local time on the gateway
  host.
- **Idle reset** (optional) -- new session after a period of inactivity. Set
  `session.reset.idleMinutes`.
- **Manual reset** -- type `/new` or `/reset` in chat. `/new <model>` also
  switches the model.

When both daily and idle resets are configured, whichever expires first wins.

## Where state lives

All session state is owned by the **gateway**. UI clients query the gateway for
session data.

- **Store:** `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- **Transcripts:** `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`

## Shared workspace locking

OpenClaw has two lock layers for shared-workspace concurrency:

1. **Session transcript locking** (always on): protects JSONL/session-store writes.
2. **Workspace mutation locking** (optional): serializes `write`/`edit`/`apply_patch` workspace mutations when enabled.

Enable optional workspace mutation locking:

```json
{
  "agents": {
    "defaults": {
      "sharedWorkspaceLocking": {
        "enabled": true
      }
    }
  }
}
```

When multiple runs can touch the same session transcript (for example queued followups, compaction, or concurrent workers on a shared workspace), OpenClaw uses a per-session lock file to serialize writes.

- Lock file path: `<sessionFile>.lock` (for example `.../sessions/<SessionId>.jsonl.lock`).
- Lock payload: JSON with `pid` and `createdAt`.
- Lock scope: one lock per normalized session file path (symlink/realpath-aware), with in-process reentrant reference counting by default.

### Behavior

- Lock acquisition uses exclusive create (`wx`): only one writer process can hold the lock file.
- While held, writes are serialized for that session transcript.
- Reentrant calls in the same process (same normalized file) share the held lock and increment a counter.
- The lock file is removed only after the final `release()` for that in-process lock owner.

### Contention behavior

If a lock already exists:

1. OpenClaw inspects lock metadata (`pid`, `createdAt`).
2. If the lock appears stale, it reclaims the file and retries immediately.
3. Otherwise it backs off (`min(1000ms, 50ms * attempt)`) and retries until timeout.

Timeout error format:

- `session file locked (timeout <timeoutMs>ms): pid=<pid>|unknown <lockPath>`

### TTL / timeout defaults

Current defaults in `session-write-lock` are:

- Acquire timeout: **10s** (`timeoutMs`, unless caller overrides)
- Stale threshold: **30m** (`staleMs`)
- In-process max hold watchdog threshold: **5m** (`maxHoldMs`)
- Watchdog check interval: **60s**
- Max-hold grace helper: `resolveSessionLockMaxHoldFromTimeout(timeoutMs + 2m grace, min 5m)`

In the main run/compaction paths, OpenClaw derives `maxHoldMs` from the agent timeout to reduce false stale releases during long runs.

### Stale lock cleanup

OpenClaw cleans stale `.jsonl.lock` files in two places:

- **Gateway startup**: scans all agent `sessions/` dirs and removes stale lock files.
- **Doctor checks**: `openclaw doctor` reports lock health; `openclaw doctor --fix` removes stale lock files.

Stale criteria include:

- missing `pid`
- dead `pid`
- invalid `createdAt`
- lock older than `staleMs`

For lock files with weak metadata (for example missing pid + invalid timestamp), OpenClaw falls back to lock-file `mtime` age before reclaiming.

### Knobs (for integrators / internal callers)

`acquireSessionWriteLock(...)` supports:

- `timeoutMs`
- `staleMs`
- `maxHoldMs`
- `allowReentrant` (default `true`)

`cleanStaleLockFiles(...)` supports:

- `staleMs`
- `removeStale` (dry-run vs repair)
- `nowMs` and optional logging hooks

## Session maintenance

OpenClaw automatically bounds session storage over time. By default, it runs
in `warn` mode (reports what would be cleaned). Set `session.maintenance.mode`
to `"enforce"` for automatic cleanup:

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "30d",
      maxEntries: 500,
    },
  },
}
```

Preview with `openclaw sessions cleanup --dry-run`.

## Inspecting sessions

- `openclaw status` -- session store path and recent activity.
- `openclaw sessions --json` -- all sessions (filter with `--active <minutes>`).
- `/status` in chat -- context usage, model, and toggles.
- `/context list` -- what is in the system prompt.

## Further reading

- [Session Pruning](/concepts/session-pruning) -- trimming tool results
- [Compaction](/concepts/compaction) -- summarizing long conversations
- [Session Tools](/concepts/session-tool) -- agent tools for cross-session work
- [Session Management Deep Dive](/reference/session-management-compaction) --
  store schema, transcripts, send policy, origin metadata, and advanced config
