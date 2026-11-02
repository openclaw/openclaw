---
doc-schema-version: 1
summary: "How OpenClaw manages conversation sessions"
read_when:
  - You want to understand session routing and isolation
  - You want to configure DM scope for multi-user setups
  - You are debugging daily or idle session resets
title: "Session management"
---

OpenClaw routes every inbound message to a **session** based on where it came
from: DMs, group chats, cron jobs, etc. All session state is owned by the
**gateway**; UI clients query the gateway for session data.

Session lists reconcile invalidated metadata before returning rows. If a native
session changes ownership during a list read, that row uses the
configured model metadata while other sessions remain available. Native metadata
is refreshed when that row is next invalidated; an unchanged list read does not
retry it.

Conversation branch listing (`sessions.branches.list`) has a ten-second request
deadline, including access checks and cold-transcript restoration. If it expires,
the Gateway returns a retryable `UNAVAILABLE` error instead of an empty branch
list. Retry after database preparation finishes. Required integrity checks and
already-admitted storage cleanup keep their own lifetimes.

Reading a compressed transcript file allows at most its stored size plus 1 MiB of
decompressed output. Archives exceeding that budget fail with a visible error and
remain unchanged. This includes valid archives with larger expansion; export
those as uncompressed JSONL to read them.
Archive publication verifies compressed output against the original plaintext byte
count, preserving compression and disk-budget retention.

To continue the same Gateway-owned session in the Control UI, terminal, or a
coding harness, see [Session synchronization and attachment](/concepts/session-attachment).

For turn ownership, queueing, stopping, and lifecycle mutation rules, see
[Session controller](/concepts/session-controller).

Retries with the same input key acknowledge an already committed input even after
another turn has started. They do not append another user message or generate a
second reply. Interrupted current turns can still resume; reusing a key for
conflicting content or sender identity is refused.

For the personal-agent default — one rolling conversation shared by all your
DM channels, with group activity and background work flowing into it — see
[The main session](/concepts/main-session).

Delivered command exchanges from the shared dispatcher are conversation history
too. OpenClaw appends the user's command and delivered reply as ordinary
user/assistant messages. Native menus and command acknowledgements on Discord
and Telegram, Slack argument menus, and Mattermost model pickers are also retained after delivery.
Later turns and chat history can read these exchanges.
Login, pairing, and sensitive `/config set` or `/debug set` values are redacted before storage.
`/new` and `/reset` put their confirmation exchange in the new session; they do not
rewrite the old session. `/btw` and `/side` stay ephemeral, and message edits or
deletions do not rewrite earlier transcript rows.

## How messages are routed

| Source          | Behavior                      |
| --------------- | ----------------------------- |
| Direct messages | Shared session by default     |
| Group chats     | Isolated per group by default |
| Rooms/channels  | Isolated per room by default  |
| Cron jobs       | Fresh session per run         |
| Webhooks        | Isolated per hook             |

Native catalog source IDs, Matrix room and thread IDs, and Signal group IDs are
case-sensitive: IDs that differ only by case identify different conversations.

With `session.scope: "global"`, the selected agent still owns its session.
The shared key `global` does not merge different agents' conversations:
commands, skills, replies, and background task notifications retain the
agent selected by the route or explicit request.
Session lists, model filters, previews, and sharing controls also retain the
stored conversation's agent, rather than the aggregate view's default agent.
In the Sessions page, enabling **Unknown** includes authorized unknown sessions
owned by the selected agent. An agent-qualified key such as `agent:ops:unknown`
is an ordinary session and remains visible when **Unknown** is off.
Renaming, pinning, or editing session metadata retains the existing message
preview without rereading the transcript. New messages, transcript replacements,
completed transcript repairs, and cold-storage restoration refresh previews; changes to model selection
or fallback state refresh the relevant model facts.
When `sessions.list` requests `includeLastMessage`, rows can also include
`lastAssistantMessage` with the latest visible assistant text and its timestamp.
This field uses the same bounded recent transcript window as other previews;
it is absent when no timestamped assistant text is available in that window.
The general `lastMessagePreview` can still contain a user message.
Stopping with `/stop`, deleting, resetting, or archiving a session cancels only that agent's work for
the selected conversation. Another agent's active turn and queued messages are
preserved even when the agents use the same session key.

## Creators and assigned owners

New delegated sessions and automations retain the verified human who initiated
the work as their creator. This is normal behavior; no Labs switch is required.
The assigned owner remains separate: reassignment alone does not transfer
creator rights for sharing, public-link management, archive, or restore. Existing
creator/admin authorization rules still apply. Existing records are not
retroactively reassigned.

A selected tool user supplies execution authority, not evidence that they
initiated the task. Autonomous work without a retained human stays
agent/system-created. Creator attribution affects discovery, creator controls,
and the personal-profile fallback when no human owner is assigned; it does not
change the executing agent, model/tool permissions, or required sandbox identity.

Public links still require explicit publication. Attribution does not publish
sessions automatically, change their anonymous read-only view, or expose private
isolation metadata. Content exclusions, revocation, and future-message behavior
are unchanged.

Attribution is stored alongside the original actor inside the existing creation
record. Original actor fields and database schema versions are unchanged. A
compatible older runtime ignores the additional attribution and uses its original
creator rules; it retains the record when writing sessions, so returning to this
runtime restores the attributed creator without changing sandbox identity.
Retain the ordinary [rollback safeguards](/install/updating/rollback-and-recovery):
this feature does not make unrelated database-format changes readable by older
binaries. An incompatible binary remains blocked rather than silently restoring
an old backup and losing later writes.

## Automatic session names

Interactive chat sessions without an explicit name generate a topic title in the
background when the Gateway dispatches their message. Naming starts alongside
worktree and reply preparation; it does not wait for the agent’s first progress
event and does not block the turn. The name appears when the title model finishes.
If the title request fails while overlapping a turn, it retries once after that
turn settles. Explicit names and manual renames are preserved.

## DM isolation

By default, all DMs share one session for continuity, which is fine for
single-user setups.

<Warning>
If multiple people can message your agent, enable DM isolation. Without it, all
users share the same conversation context, so Alice's private messages would be
visible to Bob.
</Warning>

```json5
{
  session: {
    dmScope: "per-channel-peer", // isolate by channel + sender
  },
}
```

`session.dmScope` options:

| Value                      | Behavior                                                 |
| -------------------------- | -------------------------------------------------------- |
| `main` (default)           | All DMs share the [main session](/concepts/main-session) |
| `per-peer`                 | Isolate by sender, across channels                       |
| `per-channel-peer`         | Isolate by channel + sender (recommended)                |
| `per-account-channel-peer` | Isolate by account + channel + sender                    |

Slack Agent View and Assistant View DMs are the exception: each visible root gets
its own `:thread:<rootTs>` session on top of the base that `dmScope` selects, so
those conversations stay isolated even under `main`. See
[Agent View DMs](/channels/slack/threads-and-sessions#agent-view-dms).

<Tip>
If the same person contacts you from multiple channels, use
`session.identityLinks` to map their identities to one shared peer id so
they share a session.
</Tip>

Verify your setup with `openclaw security audit`.

## Retired channel docking

Channel docking and manual cross-channel reply focus have been removed. The
`/dock-*` commands no longer move a session's reply destination to another
channel.

Use `session.identityLinks` to associate a person's identities for DM session
routing, or [thread-bound sessions](/tools/subagents#thread-bound-sessions) to
keep a supported conversation attached to a subagent. These are separate
features; neither restores manual cross-channel docking.

## Group and room routing

`session.groupScope` controls where non-direct peers store conversation
context:

| Value                 | Behavior                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `per-group` (default) | Keep each group, room, or channel in its existing channel-scoped session                  |
| `main`                | Route groups, rooms, and channels into the agent's [main session](/concepts/main-session) |

A route binding can override the global value. This is useful when only a
named team room should join the main conversation:

```json5
{
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "slack",
        peer: { kind: "channel", id: "C0123TEAM" },
      },
      session: { groupScope: "main" },
    },
  ],
}
```

Use `peer.kind: "group"` for providers that classify the room as a group.
The binding override wins over global `session.groupScope`. This setting
changes session-key selection only: DM routing, mention gating, delivery
context, and replies to the source room remain unchanged.

## Incognito sessions

Incognito sessions are available only from the Control UI's **New thread** screen. Turn on **Incognito** before starting the thread to keep its session entry, transcript, and compaction state in process memory instead of on disk. The thread expires 24 hours after creation or when the Gateway restarts, whichever comes first. Finishing a turn does not close the thread, and activity does not extend its lifetime. Expiry stops active work and deletes the session and transcript without an archive. Incognito does not run OpenClaw's automatic memory flush, and does not create a transcript archive when you reset or delete it. Codex-backed runs also start their harness thread in ephemeral mode, so Codex writes no rollout or local session-state files; other model providers use HTTP APIs and keep no local provider transcript in OpenClaw.

<Warning>
On the Codex runtime, the Codex app-server still writes each message you submit to its own diagnostic log database (`logs_2.sqlite` in that agent's Codex home), including messages in incognito threads. Codex currently offers no setting that turns this log off, so OpenClaw cannot prevent it. For conversations that must not reach disk, use an agent on the OpenClaw runtime.
</Warning>

Delegated work uses its native execution and completion owners. Live subagent activity and completion delivery remain available.

The `incognito-` segment is reserved for dashboard, subagent, and hidden internal session keys; `openclaw doctor --fix` renames any colliding legacy durable keys.

Incognito does not restrict the agent's normal tools. An explicit request to save information, or any tool-driven file write, can still persist data outside the incognito session store. Your configured model provider still processes the messages you send. Incognito content is excluded from ordinary Gateway output, delivery and response diagnostics, WebSocket event previews, raw-stream, cache-trace, and Anthropic payload logs. Live replies remain available, and OpenClaw still records operational diagnostics and content-free audit metadata such as HMAC references.

On multi-user gateways, incognito threads are visible only to admin-scope connections and never appear through another session's agent session tools or transcript search. This limits persisted session history and access through other gateway-mediated sessions; it does not make all tool, upload, approval, or configured diagnostic data ephemeral. The gateway owner or process operator can still observe live sessions.

## Remember across conversations

Separate transcripts control each conversation's local history. For a personal
or fully trusted agent, `memory.search.rememberAcrossConversations: true`
adds an optional retrieval step across that agent's other private
conversations; it does not combine their transcripts.

Private direct and persistent explicit UI conversations can supply relevant
context to one another. Under default `session.groupScope: "per-group"`, groups and channels stay separate in both directions:
their transcripts are not private recall sources, and replies in those
conversations do not receive private transcript context. The current
conversation is also excluded because its history is already loaded.

This setting does not change session keys, DM scope, routing, delivery, or
`tools.sessions.visibility`. Shared workspace memory in `MEMORY.md` and
`memory/*.md` also keeps its existing behavior. The current memory provider
must support protected private transcript recall; context engines such as
Lossless Claw remain independent and can run alongside it. See
[Active Memory](/concepts/active-memory#remember-across-conversations) for setup
and runtime details.

## Session lifecycle

Independent sessions can initialize their first turns concurrently. Requests for
the same session remain ordered; parent forks and resets retain their shared-state
coordination.

Sessions are reused until you reset them manually or opt into an automatic reset policy:

- **No automatic reset** (default `mode: "none"`) - sessions keep the same
  `sessionId`; compaction manages the active context as the conversation grows.
- **Daily reset** (`mode: "daily"`) - opt into a new session at a configured local
  hour (`session.reset.atHour`, default `4`, 0-23) on the gateway host. Daily
  freshness is based on when the current `sessionId` started, not on later
  metadata writes.
- **Idle reset** (`mode: "idle"`) - opt into a new session after `session.reset.idleMinutes`
  of inactivity. Idle freshness is based on the last real user/channel
  interaction, including browser Talk consults. Heartbeat, cron, and exec system
  events do not keep the session alive.
- **Manual reset** - type `/new` or `/reset` in chat. `/new <model>` also
  switches the model.

When both daily and idle resets are configured, whichever expires first wins.
The message that triggers an automatic reset continues in the new conversation.
Heartbeat, cron, exec, and other system-event turns may write session metadata,
but those writes do not extend daily or idle reset freshness. When a reset
rolls the session, queued system-event notices for the old session are
discarded so stale background updates are not prepended to the first prompt in
the new session.

Sessions with an active provider-owned CLI session follow the same no-automatic-reset
default. Use `/reset` or configure `session.reset` explicitly when those sessions
should expire on a timer.

Opt into automatic resets globally, then override them per chat type or channel:

```json5
{
  session: {
    reset: { mode: "daily", atHour: 4 },
    resetByType: {
      group: { mode: "idle", idleMinutes: 120 },
      thread: { mode: "daily", atHour: 6 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
  },
}
```

`resetByType` supports `direct`, `group`, and `thread`. Doctor migrates legacy `dm` entries to `direct` and `session.idleMinutes` to `session.reset.idleMinutes`; the schema rejects both retired forms.

## Gateway restart recovery

A graceful Gateway stop or restart writes one small marker for each running root
session, then aborts work promptly. A root is running when its agent loop, one of
its descendant sub-agents, or one of its background processes is active. At startup,
the Gateway clears the marker and sends one ordinary system input asking the agent
to check current files, processes, sub-agents, and external actions before continuing.
This includes channel threads and non-default agents; replies retain the session's
recorded channel and thread. Marker persistence uses the process shutdown deadline.
Shutdown and startup log per-agent marked/resumed counts and skip reasons.

Running children stop quietly and do not resume independently. Their root requester
receives the single resume input and can inspect results, send new instructions,
or spawn replacements. Cron occurrence sessions and ACP/external-harness sessions
keep their own lifecycle owners.

The input uses the recorded human owner's current authority, or the human creator
when no owner is set, narrowed by the session's current permission mode and tool
policy. A deleted or archived session, removed principal, or lost access is skipped.
A session without a human principal uses ordinary system-event authority. Saved
operator or requester snapshots do not grant permissions.

The marker records the IDs of accepted user messages still queued at shutdown.
Only those messages follow the resume input in FIFO order, each under its recorded
sender's current authority. Older crash-left queued rows remain inert. A sender that
cannot be admitted gets an ordinary failed send and can resend. New messages during
the resumed run use normal steering and queue rules; they do not wait behind a
special recovery predecessor.

A crash or `SIGKILL` writes no markers, so nothing resumes automatically. The
transcript stays available and a new message can continue the work. The agent must
inspect uncertain effects before repeating them. The Control UI shows the ordinary
conversation and resume turn without restart banners or interrupted-input notices.
There is no manual `sessions.recover` method.

Already-produced outbound messages and media keep their existing delivery queue.
An unknown delivery outcome can still require inspection; restarting does not prove
that an external action or reply happened exactly once. See
[Restart recovery](/gateway/restart-recovery) for shutdown, compatibility, and
post-update checks.

## Where state lives

- **Runtime session rows and transcripts:** `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` by default
- **Archived transcript files:** `~/.openclaw/agents/<agentId>/sessions/`
- **Legacy row migration source:** `~/.openclaw/agents/<agentId>/sessions/sessions.json`

Archive discovery uses the selected store, recorded transcript paths, and agent
directories. The pre-agent `~/.openclaw/sessions/` directory is no longer an
implicit fallback; explicitly configured paths still work.

State directories reached through symlinks are supported on SQLite and PostgreSQL,
including session deletion, transcript archiving, and retained cron history reads.

The session rows in the per-agent SQLite database keep separate lifecycle
timestamps:

- `sessionStartedAt`: when the current `sessionId` began; daily reset uses this.
- `lastInteractionAt`: last user/channel interaction that extends idle lifetime.
  Finalized user voice transcripts update this only with a new committed entry;
  replayed, assistant-only, and rejected transcripts do not.
- `updatedAt`: last store-row mutation; useful for listing and pruning, but not
  authoritative for daily/idle reset freshness.

To import legacy `sessions.json` rows and hot transcript JSONL history from an
older installation, stop the Gateway, back up its state, and run
`openclaw doctor --fix` before restarting it. Gateway and local CLI startup use
SQLite without importing, restoring, or rewriting legacy session files.
If startup finds a legacy store, it refuses readiness and prints the Doctor
command for the active profile instead of silently starting with empty history.
During Doctor import, rows without `sessionStartedAt` are resolved from the
legacy transcript JSONL session header when available. If an older row also
lacks `lastInteractionAt`, idle freshness falls back to that session start time,
not to later bookkeeping writes. Use `openclaw doctor --session-sqlite inspect
--session-sqlite-all-agents` and the [Doctor migration
sequence](/cli/doctor#session-sqlite-migration) for inspection and validation.

## Session maintenance

OpenClaw bounds session storage over time via `session.maintenance`, defaults
shown:

```json5
{
  session: {
    maintenance: {
      mode: "enforce", // "enforce" applies cleanup; "warn" only reports
      pruneAfter: "30d",
      archiveDashboardAfter: "7d", // false or 0 disables this dashboard trigger
      maxEntries: 5000,
      preserveRecent: false, // opt in with a duration such as "7d"
    },
  },
}
```

For production-sized `maxEntries` limits, Gateway runtime writes use a small
high-water buffer and clean back down to the configured cap in batches.
Session store reads do not prune or cap entries during Gateway startup, so
startup and isolated cron sessions do not pay for a full store cleanup.
`openclaw sessions cleanup --enforce` applies the cap immediately.

Ordinary entry writes and reply initialization arm background maintenance at the next age boundary,
with a periodic recheck every 30 minutes while the store remains open. This lets
eligible sessions age out without further traffic. Reply preparation does not wait
for unrelated retention cleanup. Writes that cannot change
age or count maintenance outcomes skip candidate scans. Automatic planning reads
only retention and protection metadata before entering the foreground write queue;
age candidates must reach their enabled retention phase's cutoff, and maintenance
looks up only active-session ancestry unless runtime identities need the full
session-key inventory. Cap selection retains only the required oldest eligible entries.
Automatic capacity cleanup yields the writer between batches of up to 64 entries;
explicit cleanup remains exhaustive. The writer rechecks the selected rows and their protection before applying
changes, so concurrent updates are reconsidered instead of overwritten. Activity
on unrelated sessions and protection that has ended do not invalidate the plan.
When an over-cap pass finds only durably protected entries, ordinary activity does not
repeat that futile plan. New eligible entries, restored identities, lost entry
protection, and changed policy reconsider it. Delivery cleanup resumes idle maintenance
when it releases the session's remaining recovery protection. Temporary protection from active
sessions, runtime providers, or recent activity does not suppress planning on
ordinary writes; age deadlines and the periodic recheck still resume idle cleanup.
While entry pressure still requires cleanup, capacity maintenance revisits entries
once temporary write protection ends, without requiring another entry write.
Releasing acquired session work also wakes idle capacity maintenance; overlapping
work keeps the session protected until its final admission releases.
If writes invalidate an automatic maintenance plan, its replacement waits for
the scheduled retry delay (one second, then two seconds). Further writes coalesce
into that retry without postponing it indefinitely. Three
consecutive invalidations pause automatic retries and log the cause; a new
entry write can schedule another attempt. `warn` mode skips automatic reclamation.
Certified transcript backfill and usage-cache writes retain a protected-only no-op result
while entry-change publications and scoped write receipts remain current. Unknown writes
still invalidate that result and wait for the existing quiet window before replanning.

`maxEntries` defaults to 5000 unarchived session rows. Archived rows do not consume
the cap. Existing explicit limits remain unchanged.
When pressure exceeds the cap, cleanup archives the oldest eligible ordinary
sessions instead of deleting their transcripts. Synthetic runtime sessions such
as cron, hooks, heartbeat, ACP, and sub-agents remain disposable and may be
removed. Pinned root sessions, active or admitted work, model-locked sessions, and
durable external conversation pointers are protected; the unarchived total can
therefore remain above the cap when protected rows alone exceed it.

Root sessions and sessions auto-parented to the agent's Home root can be pinned;
genuine child sessions and subagent runs reject pin requests. Persistent child
sessions retain their sidebar nesting; subagent runs appear in transcript activity
and session transcripts. Existing child pins disappear and no longer protect the session
from maintenance.

Gateway model-run check sessions are short-lived by default. Rows matching
`agent:*:explicit:model-run-<uuid>` use fixed `24h` retention, but cleanup is
pressure-gated: it only removes stale check rows when session-entry
maintenance/cap pressure is reached, and runs before the broader stale-entry
age cutoff and entry cap. Normal direct, group, thread, cron, hook, heartbeat,
ACP, and sub-agent sessions do not inherit this 24h retention.

Maintenance preserves durable external conversation pointers, including direct,
group, and thread-scoped chat sessions, while still allowing synthetic cron, hook,
heartbeat, ACP, and sub-agent entries to age out.

Shared or high-volume installations can set `preserveRecent` to protect
recently active interactive sessions and every SQLite history generation owned
by those sessions. The option is disabled when omitted or set to `false`, so
personal installations keep the normal oldest-first policy. Synthetic
model-run, cron, hook, heartbeat, ACP, and sub-agent sessions remain eligible
for bounded cleanup. Protection can temporarily keep the store above its entry
or disk target; it expires after the configured inactivity window.

Recent-session protection does not change managed-worktree garbage collection;
durable dashboard sessions auto-archive after 7 days of inactivity by default,
and `pruneAfter` archives other eligible durable sessions in place after 30 days
by default, preserving their session ids and transcript generations. Disposable
automation rows still delete at their age cutoff.

Pinned sessions and manual, legacy, age-retention, stale-dashboard, or recovery
archives are user-protected and exempt from automatic maintenance. Sessions archived because
`maxEntries` was reached record that reason and remain searchable/restorable
until physical usage exceeds `maxDiskBytes`; disk-budget cleanup may then delete
the oldest cap archives after cheaper artifacts and unreferenced history are
exhausted. Sessions without a recorded archive reason remain protected.

After skipping a history generation or archived session, disk-budget cleanup
rechecks physical usage before considering another deletion. A measurement
failure stops the sweep.

Background disk-budget checks run at most every 30 minutes on entry writes.
Unchanged entry patches do not schedule a check.
Delete and reset operations can request a check sooner, but repeated requests
coalesce to at most one forced check per minute per store. If cleanup exhausts
eligible history and the store remains over budget, automatic checks back off
for 30 minutes and log one warning until the pressure clears or the budget changes.
Per-agent legacy store locators and their canonical SQLite paths share this queue
and backoff. Custom aggregate store locators retain their own maintenance scope.
After a pass reclaims nothing, the next automatic check first inspects eligible
data without reserving the foreground writer; protected-only pressure does not
repeat archive pruning or checkpoints. Manual cleanup still runs immediately.
The warning recommends raising `session.maintenance.maxDiskBytes` or exporting
and deleting unneeded sessions. Checks resume on subsequent activity;
`openclaw sessions cleanup --enforce` remains available immediately.

Cleanup first tries to truncate the WAL without waiting for readers. If readers
prevent truncation, a complete PASSIVE checkpoint is sufficient: frames relevant
to cleanup must have reached the main database, even if the WAL file remains allocated.
Retained WAL bytes still count toward the physical budget. Successful cleanup
logs one outcome with the before/after bytes and removal counts.
Archive pruning measures physical usage outside the foreground writer queue.
Each deletion and page-reclamation unit retains its own admission, with a yield
between reclamation units. Archive retention also selects candidates outside the
writer queue, then rechecks and removes at most 16 rows per admission, yielding
between batches while retaining the same 256-row selection limit per pass.
Concurrent shrinkage can prune one additional oldest derived archive before the
next measurement ends the sweep; canonical retention and deletion eligibility
checks are unchanged.

An incomplete SQLite WAL checkpoint is a separate deferral. Cleanup preserves
archives and history instead of deleting more data behind the blocked checkpoint.
The result records `deferredReason: "checkpoint-incomplete"`, WAL bytes before and
after, and the checkpoint outcome. Manual cleanup and subsequent throttled
automatic checks retry the checkpoint: an earlier blocked observation cannot
suspend cleanup indefinitely when another connection completes a checkpoint
without publishing its result. Cleanup still requires the checkpoint owner to
record completion after the pending cleanup work. Newer frames from concurrent
writes do not erase that completion. Each SQLite cleanup
deletion or vacuum commit requires a new completion before further pruning, so a
reader pinning those changes still defers cleanup. Ordering uses monotonic time;
elapsed time, a budget change, or a system clock correction cannot release the gate.
Normal periodic checkpointing continues. A published completion allows the next
activity to retry immediately; otherwise the normal check interval applies.

Look for `session history disk budget deferred until a completed WAL checkpoint is observed`
in the Gateway log. Its checkpoint fields include bounded operation names for
explicitly tracked readers, connection and thread IDs, and open-transaction flags.
Collecting these facts does not keep connections open or change worker retirement.
They do not prove which connection holds the blocking SQLite read mark. Raw native
statements outside explicit reader tracking, other workers, and other processes
can remain unidentified. No transcript contents, SQL text, or bound values are included.

If you previously used DM isolation and later returned `session.dmScope` to
`main`, preview stale peer-keyed DM rows with
`openclaw sessions cleanup --dry-run --fix-dm-scope`. Applying the same flag
retires those old direct-DM rows and keeps their transcripts as deleted
archives.

Preview any maintenance run with `openclaw sessions cleanup --dry-run`.

## Inspecting sessions

| Command                    | Shows                                           |
| -------------------------- | ----------------------------------------------- |
| `openclaw status`          | Session store path and recent activity          |
| `openclaw sessions --json` | All sessions (filter with `--active <minutes>`) |
| `/status` in chat          | Context usage, model, and toggles               |
| `/context list`            | What is in the system prompt                    |

<a id="further-reading" />

## Related

- [Session search](/concepts/session-search) - full-text recall across past transcripts
- [Session Pruning](/concepts/session-pruning) - trimming tool results
- [Compaction](/concepts/compaction) - summarizing long conversations
- [Session Tools](/concepts/session-tool) - agent tools for cross-session work
- [Session Management Deep Dive](/reference/session-management-compaction) -
  store schema, transcripts, send policy, origin metadata, and advanced config
- [Multi-Agent](/concepts/multi-agent) - routing and session isolation across agents
- [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools) - per-agent sandbox and tool restrictions, including session visibility
- [Transcript hygiene](/reference/transcript-hygiene) - in-memory, provider-specific transcript sanitization applied before a run
- [Command queue](/concepts/queue)
- [Channel routing](/channels/channel-routing) - how inbound messages are routed to sessions
