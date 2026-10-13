---
summary: "Split-send DM coalescing and automatic inbound recovery after a bridge or gateway restart"
read_when:
  - Debugging a command and its URL arriving as two turns
  - Understanding what happens to messages sent while the gateway was down
title: "iMessage message behavior"
sidebarTitle: "Message behavior"
---

What OpenClaw does to inbound iMessages before an agent sees them.

<a id="coalescing-split-send-dms-command--url-in-one-composition"></a>

## Coalescing split-send DMs (command + URL in one composition)

Apple can store a command and its URL preview as separate physical `chat.db` rows. `imsg` 0.13.1 and newer coalesces those rows before watch, history, or search returns the message, so OpenClaw receives one logical inbound message without adding channel-specific DM latency.

No iMessage coalescing setting is needed. The retired `channels.imessage.coalesceSameSenderDms` key is removed by `openclaw doctor --fix`. Generic `messages.inbound` debounce remains available when you intentionally want to batch rapid text messages across a channel.

If command-plus-URL sends arrive as separate agent turns, update `imsg` on the Messages Mac:

```bash
brew update && brew upgrade imsg
```

## Inbound recovery after a bridge or gateway restart

iMessage recovers messages missed while the gateway was down, and at the same time suppresses the stale "backlog bomb" Apple can flush after a Push recovery. The default behavior is always on, built on durable ingress plus an age fence.

- **Durable replay protection.** Before advancing the recovery cursor, OpenClaw journals each raw row in the shared SQLite ingress queue with its Apple GUID as the event ID. A completed row leaves a tombstone for about 4 hours, capped at 10,000 entries, so a replay with the same GUID is dropped even after a restart. A pending row stays recoverable until dispatch adopts it.
- **Downtime recovery.** On startup the monitor remembers the last durably admitted `chat.db` rowid (a persisted per-account cursor) and passes it to `imsg watch.subscribe` as `since_rowid`, so imsg replays rows that were not yet journaled and then tails live. Rows journaled before a crash resume from SQLite. Replay is bounded to the most recent 500 rows and to messages up to ~2 hours old, and GUID tombstones drop anything already handled.
- **Stale-backlog age fence.** Rows above the startup boundary are genuinely live; one whose send date is more than ~15 minutes older than its arrival is the Push-flush backlog and is suppressed. Replayed rows (at or below the boundary) use the wider recovery window instead, so a recently-missed message is delivered while ancient history is not.

Recovery works over both local and remote `cliPath` setups, because `since_rowid` replay runs over the same `imsg` RPC connection. The difference is the window: when the gateway can read `chat.db` (local), it anchors the startup rowid boundary, caps the replay span, and delivers missed messages up to a couple of hours old. Over a remote SSH `cliPath` it cannot read the database, so the replay is uncapped and every row uses the live age fence — it still recovers recently-missed messages and still suppresses old backlog, just with the narrower live window. Run the gateway on the Messages Mac for the wider recovery window.

### Operator-visible signal

Suppressed backlog is logged at the default level, never silently dropped (the `recovery` flag shows which window applied):

```text
imessage: suppressed stale inbound backlog account=<id> sent=<iso> recovery=<bool> (<N> suppressed since start)
```

### Migration

`channels.imessage.catchup.*` is deprecated — downtime recovery is automatic and needs no config for new setups. Existing configs with `catchup.enabled: true` remain honored as a compatibility profile for the recovery replay window. Disabled catchup blocks (`enabled: false` or no `enabled: true`) are retired; `openclaw doctor --fix` removes those.
