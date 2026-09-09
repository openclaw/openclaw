---
summary: "sessionKey patterns, sessionId lifecycle, SessionEntry fields, and the transcript event stream"
read_when:
  - "You need to debug session ids, transcript events, or session row fields"
  - "Reading or writing SessionEntry fields, forks, or transcript entry types"
title: "Session keys, ids, and transcript events"
---

## Session keys (`sessionKey`)

A `sessionKey` identifies which conversation bucket you are in (routing + isolation). Canonical rules: [/concepts/session](/concepts/session).

| Pattern                      | Example                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| Main/direct chat (per agent) | `agent:<agentId>:main`                                      |
| Group                        | `agent:<agentId>:<channel>:group:<id>`                      |
| Room/channel (Discord/Slack) | `agent:<agentId>:<channel>:channel:<id>` or `...:room:<id>` |
| Cron                         | `cron:<job.id>`                                             |
| Webhook                      | `hook:<uuid>` (unless overridden)                           |

## Session ids (`sessionId`)

Each `sessionKey` points at a current `sessionId` (the SQLite transcript identity that continues the conversation). Decision logic lives in `initSessionState()` in `src/auto-reply/reply/session.ts`.

- **Gateway reset** (`/new`, `/reset`) records a reset boundary in an existing persisted session and keeps its `sessionId`. A session that does not exist yet receives a new id.
- **No automatic reset** is the default. The current `sessionId` continues while compaction keeps the active model context bounded.
- **Daily reset** (`session.reset.mode: "daily"`) creates a new `sessionId` on the next message after the configured local-hour boundary (`session.reset.atHour`, default `4`).
- **Idle expiry** (`session.reset.mode: "idle"` with `session.reset.idleMinutes`, or legacy `session.idleMinutes`) creates a new `sessionId` when a message arrives after the idle window. If daily and idle are both configured, whichever expires first wins.
- **Control UI reconnect resume** preserves the currently visible session for one reconnect send when the Gateway receives the matching `sessionId` from an operator UI client. This is a one-shot signal; ordinary stale sends still create a new `sessionId`.
- **System events** (heartbeat, cron wakeups, exec notifications, gateway bookkeeping) may mutate the session row but never extend daily/idle reset freshness. Reset rollover discards queued system-event notices for the previous session before the fresh prompt is built.
- **Automatic parent fork policy** uses OpenClaw's active branch when creating a thread or subagent fork. If that branch is too large (over a fixed internal cap, currently 100K tokens), OpenClaw starts the child with isolated context instead of failing or inheriting unusable history. Sizing is automatic and not configurable; legacy `session.parentForkMaxTokens` config is removed by `openclaw doctor --fix`.
- **Operator forks**: `sessions.create { parentSessionKey, fork: true }` branches from the parent's current state. Admission uses the selected child model's effective usable input capacity, falling back to the 100K safety cap when model capacity is unavailable. A normal fork is refused while the parent has an active run; adding `forkFrom: "last-completed"` copies only through the last completed assistant message, excluding the in-progress tail. Unlike automatic parent forks, an operator fork over its capacity limit is rejected rather than accepted with isolated context. The child inherits the parent's model selection unless one is passed explicitly. The response marks it `forkedFromParent`, and token counters start fresh.
- **Message forks**: `sessions.fork { sessionKey, entryId }` creates a child from the active-path prefix before the selected user message and returns that message to the composer for editing. The parent remains unchanged. Incognito forks retain the parent's in-memory storage class; restarting the Gateway removes both sessions. Codex fork verification compares complete attested submitted prompts, including whitespace; the bounded display-import projection is not a substitute for that evidence. See [Control UI](/web/control-ui) for fork and rewind actions.

## Session store schema

The runtime store keeps `SessionEntry` values in per-agent SQLite. The value type is `SessionEntry` in `src/config/sessions.ts`. Key fields (not exhaustive):

- `sessionId`: current transcript id used to address SQLite transcript rows
- `sessionStartedAt`: start timestamp for the current `sessionId`; daily reset freshness uses this. Legacy rows may derive it from the JSONL session header.
- `lastInteractionAt`: last real user/channel interaction timestamp; idle reset freshness uses this so heartbeat, cron, and exec events do not keep sessions alive. Legacy rows without this field fall back to the recovered session start time.
- `updatedAt`: last store-row mutation timestamp, used for listing/pruning/bookkeeping - not the daily/idle freshness authority.
- `archivedAt`: optional archive timestamp. Archived sessions stay in the store with their transcript intact and are excluded from normal active listings.
- `pinnedAt`: optional pin timestamp. Active pinned sessions sort ahead of unpinned sessions; archiving a session clears its pin.
- Codex thread interop: both fields follow the Codex thread-management shape - the `archived`/`pinned` booleans on the wire are always derived from the timestamp and stamped server-side, matching Codex `threads.archived_at` semantics and camelCase serialization. OpenClaw timestamps are epoch milliseconds while Codex uses epoch seconds, so bridges convert at the `codex` plugin seam. Codex has no pin API yet (`thread/archive`/`thread/unarchive` only); pinned state stays OpenClaw-side until one exists, at which point the matching shape lets bound sessions round-trip pin state mechanically.
- Codex supervision lists only non-archived native threads. A Gateway-local `idle` or `notLoaded` activity-unknown thread can be archived through native `thread/archive` only after the operator explicitly confirms that no other Codex process owns it; the plugin performs a fresh process-local status read first, and the thread then disappears from the catalog. That read cannot prove that another App Server process is not using the thread. OpenClaw refuses to archive active and error rows, and paired-node archive is unavailable until the node bridge can own the full streamed thread lifecycle. Unarchiving in a native Codex client makes the thread eligible to appear again.
- `lastReadAt` / `markedUnreadAt`: read-state timestamps stamped server-side by `sessions.patch { unread }` - `unread: false` records a read (sets `lastReadAt`, clears `markedUnreadAt`); `unread: true` records `markedUnreadAt` and marks the session unread until the next activation or explicit read. Session rows expose the marker alongside a derived `unread` boolean so already-open clients preserve manual reminders while still acknowledging new activity. Automatic read patches from clients that support the advertised unread acknowledgement contract include `expectedMarkedUnreadAt` (`null` means no marker); a newer marker makes that acknowledgement a successful no-op instead of erasing newer intent. Bare `unread: false` requests retain the legacy clear behavior, so protection across several connected clients requires each active client to support the contract. Sessions never marked read stay `unread: false`, so existing installs do not light up on upgrade.
- `lastActivityAt`: timestamp of the last completed agent run that counts as unread-worthy activity (user, channel, and cron runs). Heartbeat and internal-event turns, plus metadata patches, do not update it; `updatedAt` is not an activity signal.
- `sessionFile`: legacy marker retained for migration/archive compatibility; active runtime uses SQLite identity
- `chatType`: `direct | group | room`
- `provider`, `subject`, `room`, `space`, `displayName`: group/channel labeling metadata
- Toggles: `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`, `sendPolicy` (per-session override)
- Model selection: `providerOverride`, `modelOverride`, `authProfileOverride`
- Token counters (best-effort/provider-dependent): `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: how many times auto-compaction completed for this session key
- `memoryFlushAt` / `memoryFlushCompactionCount`: timestamp and compaction count of the last pre-compaction memory flush

The Gateway is the authority: it may rewrite or rehydrate entries as sessions
run. For legacy file-backed installs, migrate with
`openclaw doctor --session-sqlite import --session-sqlite-all-agents` instead of
editing `sessions.json` and expecting runtime to keep reading that file.

## Transcript event structure

Transcripts are managed by the OpenClaw session accessor and exposed to runtime code through identity-based helpers. The event stream is append-only:

- First entry: session header - `type: "session"`, `id`, `cwd`, `timestamp`, optional `parentSession`.
- Then: entries with `id` + `parentId` (tree structure).

Notable entry types:

- `message`: user/assistant/toolResult messages
- `custom_message`: extension-injected message that _does_ enter model context (rendered in the TUI when `display: true`, hidden entirely when `display: false`)
- `custom`: extension state that does _not_ enter model context (for persisting extension state across reloads)
- `compaction`: persisted compaction summary with `firstKeptEntryId` and `tokensBefore`
- `reset`: a fresh history window, optionally retaining messages from `firstKeptEntryId`
- `branch_summary`: persisted summary when navigating a tree branch

History readers keep the latest reset window across later compactions: explicitly retained reset messages and messages after that reset remain visible, but older messages and compaction summaries do not reappear. Model context follows the latest reset or compaction instead, so compaction can summarize the current conversation without reopening its earlier history.

Model-only callers should await `SessionManager.openModelContextAsync(target, { admission?, signal? })` to create a detached, non-persisting view without blocking the Gateway event loop on durable history scans. `openModelContext()` provides the same view for synchronous consumers. The reader selects payloads in SQLite and retains lightweight navigation outside the model window, without introducing a history size cutoff. Storage-only native prompt text and tool-result details stay out of that view; mirror identity, sender and media facts, tool content, and valid provider replay state remain available. Native fork verification, replay, exports, and doctor operations continue to use full-fidelity evidence readers.

`SessionManager.readSessionContext(target, read, { admission? })` lets a synchronous
consumer process full-fidelity context messages inside one read-only snapshot.
The callback receives `(messages, header)`: a lazy message iterable and the
unvalidated stored header. Missing stores supply an empty iterable and no header
without creating a database. An optional admission excludes the current admitted
user row and later events. Callback errors propagate, and the iterator closes
when the callback returns or throws; it cannot be retained for later reads.
This lets replay consumers enforce their existing limits during acquisition
without silently dropping earlier history. Navigation still scales with the
transcript, and individual selected rows are decoded whole; this is not a fixed
process-memory ceiling.

Durable model-context reads run in a worker. Codex native replay and settled-turn verification keep that lazy read and its consumer together in a worker. Worker reads are serialized per reader and reuse an idle worker. Admission receipts are validated inside the read snapshot and again before the result is accepted; reads without an admission instead check the session’s rewrite generation and last event sequence. Admitted reads retain their turn boundary, so later appends alone do not invalidate them. An invalidated read or canceled signal rejects the result. Callers carry their original cancellation signal through context acquisition and check that their owner remains active before invoking hooks, starting a model run, or applying a proposal. Incognito sessions use the same operation in the Gateway process because their SQLite database is held in memory.

OpenClaw intentionally does not "fix up" transcripts; the Gateway uses `SessionManager` to read/write them.
