---
summary: "What survives a gateway restart or crash: eligible interrupted turns resume, native subagents settle, and queued deliveries drain"
read_when:
  - You want to know whether restarting the gateway loses in-progress agent work
  - An agent run was interrupted by a restart, crash, or config reload
  - You are debugging automatic session recovery after the gateway comes back up
title: "Restart recovery"
---

Conversations, transcripts, scheduled jobs, native subagent records, and queued
outbound messages live on disk. Main chat sessions that were working when the
Gateway restarted always enter automatic main-session recovery, including after
a crash, forced kill, or missed shutdown marker. No operator action is needed to
resume them. Recovery is always on. Exhausted infrastructure retries, or a
missing durable message-action authority claim, may tombstone one session
until you inspect or replace it.

Every Gateway process shutdown preserves eligible unfinished turns, including a
plain `SIGTERM`, a systemd or launchd service stop/restart, and
`openclaw gateway stop`. A Gateway stopped today resumes that work when it starts
tomorrow, without a new user message. Shutdown uses the same interruption and
recovery marking as a managed restart, with the existing drain deadlines.
Explicit session Stop/cancel remains terminal. The crash-loop breaker, recovery
retry budgets, current-authority checks, and archived/reset exclusions still apply.
Startup prepares and reconciles interrupted sessions independently of its FIFO
dispatch queue. A session waiting for execution capacity or execution start does
not block reconciliation of later sessions or already-delivered replies. Recovery
uses `agents.defaults.maxConcurrent` for its separate execution lane, leaving
interactive reply slots available. Queued recovery does not charge an attempt
before capacity is available. Stopping the Gateway cancels and joins the dispatch
queue while preserving unfinished claims for the next process.

Ordinary session interruptions and timeouts retain their original cancellation
cause; they do not create Gateway-restart recovery custody. Chat admission uses
the cancellation owner's recorded cause, including when interrupted before execution.
Before accepting another message, the Gateway retires leftover recovery records
whose runs are all recorded terminal and have no remaining execution or delivery
owner. For a killed conversation, it also releases unfinished fences after checking
that no run or session work remains active and no final delivery is pending. This
lets a stopped conversation continue without resetting its history.
A worker placement already marked failed does not start another automatic recovery
turn. Recovery records the failure and its next step once; later restarts preserve
that outcome. Inspect the placement error, finish any pending worker cleanup, then
repair or restart the worker and use Resume. Explicit session recovery remains
available after worker cleanup is complete.

Cron owns recovery of interrupted scheduled turns. An enabled, unchanged,
time-scheduled agent job interrupted before delivery gets one fresh retry after
startup, including one-shot jobs. Its original run remains recorded as interrupted.
The retry uses the job's current authorization and tool limits and asks the agent
to reconcile prior work before continuing. Main-session recovery leaves a local
notice and releases the interrupted cron turn to the scheduler; it does not borrow
an earlier operator turn's authority. Possible prior delivery, changed or disabled
jobs, and command, script, event, or process-exit jobs remain interrupted without
automatic replay. Inspect their run history before continuing them manually.

Inter-session steering updates remain context for the executing turn. When that
turn retains a Control UI, channel, or authenticated operator source claim,
recovery uses the claim rather than treating the latest steering message as a new
delegated request. This includes authenticated non-browser clients whose ingress
is labeled internal. Before execution, the Gateway restores the exact operator
source under current identity and access policy; a revoked source cannot resume.
The existing source-authorization and delivery checks still apply; a transcript
message alone cannot restore missing sender authority. Accepted `sessions_send`
follow-ups into main chat sessions also retain their admitted operator source,
so they resume after a restart without another user message. They remain
internal inputs: recovery does not inherit a sender's channel delivery rights,
and a follow-up without an authenticated operator source cannot reconstruct
authority from its transcript.

Automatic goal continuations retain that same authenticated operator source,
including continuations after subagent announcements or requester-settle yields.
If interrupted mid-tool, they resume through normal startup recovery under current
permissions. The saved goal and its transcript do not grant authority on their own.

An accepted child continuation, including a child created with `sessions_spawn`
or an interrupted child resumed with `sessions_send`,
keeps the restored operator's current identity and permission checks independently
of the parent's recovery claim. Completing the parent does not cancel that child.
A fresh authenticated human follow-up in a completed task session retains its own
recovery source. After a restart, the child recovery owner resumes that follow-up
from its saved history without another user message or reuse of the original
parent turn's grant.
Provider retries reuse the child's retained authority, including when session tools
are prepared again after a transient provider error.
Explicitly stopping the parent still cancels its children. Revoking the operator,
replacing the source session, or stopping the Gateway still invalidates the child's
authority.

This includes automation turns running in dashboard main sessions. If a restart
exhausts its drain budget, cancellation preserves restart recovery even when the
provider reports an error and the turn settles before shutdown discovers it.
The next visible message preserves an interrupted turn's recovery claim even
when its saved status is failed, timed out, or killed. Recovery resumes the
interrupted work before the new message takes foreground ownership.

This page describes what survives a restart, how interrupted work is detected,
and what the automatic resume looks like.

During startup, a new reply waits for its agent's model and plugin runtime to
finish loading. Agents that are already ready can serve replies while other
agents continue loading. Startup preparation failures still report an error.

Startup orphan marking runs after plugin loading and startup completion. It uses
the existing active-session index to exclude archived rows before inspecting
recovery metadata, without reading full transcripts. Client connections, channels,
startup-gated RPCs, startup hooks, and saved-input replay still wait for marking; chat readiness stays
gated until saved-input recovery finishes. Marking failures produce a warning
without aborting startup,
and the existing recovery sweep retries failed stores. Main-session recovery and
queued deliveries still wait for subagent source restoration before resuming
interrupted work.

## What survives a restart

| State                         | Storage                                                      | Behavior across restart                                                         |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Conversation history          | Per-agent SQLite database                                    | Untouched; sessions continue from the stored transcript                         |
| Accepted chat follow-ups      | Per-agent SQLite pending inputs; browser outbox when present | Eligible interrupted inputs resume at startup, without a connected client       |
| Interrupted main-session turn | Per-agent SQLite session row and transcript                  | Automatically resumed or reconciled a few seconds after startup                 |
| Subagent runs                 | SQLite (shared state database)                               | Restart-interrupted runs resume with restored authority and notify their parent |
| Queued outbound deliveries    | SQLite delivery queue                                        | Drained after restart; undelivered replies are retried                          |
| Scheduled (cron) jobs         | SQLite cron store                                            | Schedules persist; the scheduler re-arms on boot                                |
| Restart continuation          | SQLite restart sentinel                                      | One-shot follow-up dispatched to the session that asked for the restart         |
| Background exec processes     | Process memory; notification obligation in session row       | Processes end; eligible owning sessions wake once with an unknown outcome       |
| Gateway terminal PTYs         | Process memory                                               | End with the old process; terminal sessions are not recovered                   |

Outbound recovery keeps checking queued deliveries when the Gateway restarts
before a platform-send lease expires. It waits for the lease before inspecting
the send and still reconciles uncertain outcomes before any replay.

The Gateway resumes eligible accepted `chat.send` inputs from SQLite at startup,
in acceptance order within each session. This includes queued inputs left by a
process kill, without waiting for a client or history read. Recovery uses the
original submission ID and approved input, then rechecks current operator
authority and the original session before admission. It never restores the old
execution authority or starts the same consumed input twice. Control UI inputs
that requested reconnect resumption retain that behavior, including when the
session has crossed its idle or daily reset cutoff.
Recovered inputs retain their verified requester profile, participant attribution,
and session personal preferences. This does not restore the old connection or
grant the recovery caller access to unrelated personal account actions.

If an input exhausts the existing bounded attempts on a transient failure, later
inputs in that session remain interrupted too, preserving their replay order.
This also applies when the earlier input is an inter-session update.
Up to four sessions replay concurrently; each session retains acceptance order,
including across retries. No additional retry loop is started. Replay and its
backoff run outside the subagent recovery span, so registry activation does not
wait for saved-input delivery. Gateway shutdown still joins that delivery work.
The existing chat-send startup gate and main-session recovery sweep wait until
replay and registry recovery settle. This prevents new input from overtaking
saved input and the sweep from racing saved-input predecessor admission; startup
completion does not wait for replay.
Before replaying queued inter-session updates, the Gateway resumes any interrupted
main turn through its existing recovery owner, preserving the predecessor's order.
The updates remain queued when that owner defers recovery.
If the crash-loop breaker pauses the predecessor, startup replay waits for the
existing boot owner to clear quarantine, then resumes the predecessor and saved
inputs in order. Shutdown or another restart cancels that wait without replaying
or discarding the saved inputs.

Per-input replay diagnostics record the input kind, outcome, wait reason, attempt
count, and elapsed milliseconds without message content or session/input IDs.
`sourceLoadMs` measures the saved-input read, `sessionLoadMs` the current session
reads, `authorityRestoreMs` operator restoration, and `communicationAdmissionMs`
the peer communication check. `dispatchAckMs` ends at the dispatch acknowledgment;
it includes preparation before that acknowledgment, not provider execution or
model completion afterward. `retryWaitMs` separates retry backoff from active
work. Timings accumulate across attempts and are inclusive: session checks during
operator restoration also appear in `authorityRestoreMs`, so phase timings must
not be added together. `totalMs` is the elapsed time for that input's replay.

Automatic chat-input recovery selects inputs accepted in the past 24 hours;
the existing bounded recovery attempts may finish after that window. Cancelled
inputs and reset, archived, or replaced sessions do not resume. Inputs whose
operator access was revoked, or that require explicit per-run client tool
bindings, remain interrupted with the existing recovery notice. Ordinary inputs
resume without the old connection's capabilities: inline widgets, device UI
commands, and task-suggestion delivery remain unavailable to that recovered turn.
Incognito inputs do not survive a process restart. Provider-review continuations
require their process-local acknowledgment and are not replayed automatically;
refresh the findings and acknowledge them again after restart.

The Control UI retains accepted text and attachments in its outbox until the
Gateway confirms transcript consumption. Reconnect and manual retries reconcile
the same saved receipt and submission ID, so a retry cannot duplicate server
recovery. Browser-local messages that the Gateway never accepted still belong
to the outbox. During startup recovery, new `chat.send` requests receive the
existing retryable startup-unavailable response. This keeps reconnecting clients
from sending successors ahead of saved inputs. The gate opens when the startup
recovery pass settles, including when inputs are excluded or recovery fails;
unresumable inputs retain their interrupted notice.

Requests refused before dispatch and chat sends interrupted while waiting for
session admission return a retryable `UNAVAILABLE` error with
`details.reason: "gateway-restarting"`. A restart does not turn an unstarted
message into a terminal Stop result. The Control UI and native chat outboxes
retain the original message ID and retry after the Gateway becomes available.
Native Apple live sends with attachments restore the draft for manual retry;
already queued attachments retain their outbox recovery.

A disconnected RPC may already have performed its work. Clients reconcile
accepted or uncertain sends through their existing receipts and history rather
than automatically replaying every pending RPC. Already running main-session
turns use the recovery owner described below; the drain budget is unchanged.

Accepted Control UI input is committed to its admitted source session before ACP
execution or question consumption. If the conversation routes to a bound ACP
session, the source keeps the original request and the bound session owns the ACP
transcript and reply. An output-persistence failure does not make consumed input
eligible for automatic resubmission.

Inputs accepted by older versions without resumable custody, and inputs outside
the 24-hour automatic recovery window, remain available for explicit resend.
Cancelled input is not replayed.
An uncertain submission stays unconfirmed until its outcome can be reconciled
or the user chooses to retry it. Recovery of a turn already in the transcript
does not depend on the browser returning.

Accepted `sessions_send` agent updates recover from their saved input and original
delivery ID. Stores still undergoing startup inspection are rediscovered after their
existing admission owner finishes, without waiting for another Gateway restart.
Each rescan uses the current configuration and communication permissions.
Shared stores keep each session’s logical agent identity separate from the physical
database owner. Temporary admission, worker capacity, and storage-readiness failures
get up to three attempts, waiting 5 seconds and then 10 seconds between attempts.
Recovery preserves the accepted identity when older saved delivery metadata omitted
an unset lifecycle revision during JSON storage. An identical completed input returns
its recorded outcome; it does not start another turn. Changed input still conflicts.
Each attempt checks the original source and destination sessions and current
communication permission again. Reset, replaced, archived, or permission-denied
sessions stop automatic delivery. Unknown failures and exhausted retries leave the
input saved, with a fixed failure-reason code and attempt count recorded in the
recovery notice details. The notice explains the failure and directs you to resend
the update or ask the sender to retry. Detailed diagnostics stay in operator logs. Recovery never
reruns the sender task or restores old approvals.

If an accepted peer input was already consumed by a turn when the Gateway died,
main-session recovery uses its saved delivery source to resume that turn. It checks
the exact interrupted run's delivery before falling back to an older transcript key;
an older delivery cannot override an existing exact match. Recovery checks
the original endpoints and current communication permissions again, including
after another forced restart. Recovered execution retains these checks for tool
effects, so revoking communication permission stops further effects. Its authority
follows successors committed by the compaction owner; unrelated endpoint replacements
still stop execution. The input remains consumed and is not submitted as a new
message. A queued session event
joins this recovery through normal session admission instead of treating the
missing live sender as an ended session.

If the original peer endpoint was reset, archived, or lost communication permission,
recovery records one interruption notice and settles that input through the existing
recovery owner. Temporary storage failures remain retryable.

When an update replaces the bundled Control UI, an open tab reloads after the
Gateway reports the new build. Automatic recovery for that reported build and
manual reloads share a bounded document-readiness check, so a transient failed
check does not immediately strand the tab. Generic lazy-chunk failures make one
automatic check and leave further recovery to the visible retry action. The
browser still limits automatic navigation to one reload per target build. If the
Gateway remains unavailable, use the visible reload action once it is reachable.

Downgrading to `v2026.9.2` preserves newer accepted-input records, but that version
rejects same-ID retries against retained newer receipts before execution. This
includes queued or interrupted inputs and consumed collected-input receipts.
Consumed receipts remain excluded from pending counts. Individually consumed
inputs have already left the pending-input store and retain normal transcript
duplicate prevention. Upgrading again restores matching unconsumed-input recovery through
fresh authentication and admission, provided the session and accepted input have
not been changed or removed. Already-consumed input remains consumed. Do not
delete receipts or change message IDs merely to bypass a downgrade conflict.

Native Codex recovery reconstructs saved document contents under the current
attachment policy and context limits. The Codex plugin owns that native input
path: update its artifact alongside the Gateway. An intentionally pinned older
plugin does not acquire the fix from a core-only update.

A detached harness completion that has entered a parent turn with an outbound
channel route can retain an exact source completion, terminal outcome, and requester-session claim. After a crash, main-session recovery
continues that admitted turn without starting the child again. The original
completion identity remains distinct from the recovery run. A retained final
receipt settles the admitted completion even if the old native monitor no longer exists; a
pending recovery claim is not a delivered result. A later outcome cannot authorize
the earlier completion input or settle its receipt. Cancellation, session replacement,
and missing or contradictory source identities do not authorize replay. A held admission
or still-valid admitted input keeps recovery pending. Native parent rotation must preserve
the current connection and requester identity checks. A later parent registration cannot
supply missing historical ownership.

Queued requester finals also retain their original completion source alongside the
final-delivery intent. Command admission snapshots the source, session lifecycle,
and route before execution; a refreshed cache cannot lend a successor’s source to
a finishing run. An identified send on that captured route records a durable
receipt before queue acknowledgement, including when terminal cleanup has already
retired the active recovery claim. Every logical final and every physical payload
in its batch must have successful identified delivery evidence. Reported recipients
and threads, including nested aggregate receipt parts, must match the captured route;
omitted provider metadata retains the existing channel contract.
Later cleanup cannot replace that receipt with an earlier capture, and a newer
requester or different route cannot borrow it. Empty, unsent, suppressed, or
uncertain results do not establish delivery. Existing missing-receipt records are
not retroactively treated as delivered.

An interrupted admitted completion keeps its complete recovery claim even when
the saved run status is failed, timed out, or killed. The next visible message or queued
follow-up resumes that recovery before taking foreground ownership or entering
the active transcript. Session reuse must not attach the old completion to the
new message. Recovery still checks the admitted input, requester lifecycle,
delivery receipt, and replay safety; it does not infer delivery from a terminal
run status.

Before parent completion admission, native Codex pending assignments retain their
run, child-thread, native-parent, and known native-turn identities in the existing
parent binding metadata. Accepted follow-ups can also retain their submission
receipt there. No new table or Tasks record is created, and historical Tasks
rows are not imported. When the parent registers again, recovery reads the saved
assignments and native history under fresh host-issued completion authority. It
checks the original requester session, lifecycle, connection, and child lineage
before restoring observation or routing a result. Native-parent thread rotation
can preserve that metadata within the same requester lifecycle and connection;
a reset, requester-generation replacement, or connection-policy change does not
authorize adoption. Missing historical ownership stays unknown. This recovery
requires a retained assignment and a new parent registration; native lineage
alone does not reconstruct an unrecorded completion obligation.

The admitted-turn recovery described above applies to newly recorded
channel-delivery claims, not route-less, transcript-only, or Control UI parents.
It does not recover every older native completion. Progress messages, empty or
truncated receipts, and uncertain sends cannot establish final delivery. The
Gateway and Codex plugin must both be updated for recovery joining. Older builds
may discard the added receipt fields while rewriting session metadata, even
without a SQL schema change. Finish pending completion recovery before downgrading;
do not delete consumed inputs or change source IDs to force another delivery.

Pending delivery rows drain or retry after restart. When a delivery exhausts its
retry budget, recovery reclaims expired producer custody. An active producer
keeps ownership. Failed deliveries cannot send again, but retain the information
needed to settle their owning session or conversation. If that update fails or
the gateway crashes, recovery resumes the update without resending the message.
After settlement, failed rows discard their payload. Only reusable or
crash-ambiguous owners keep a minimal bounded or permanent receipt that prevents
duplicate delivery. Delivery uncertainty notices retain their acknowledgment,
so a repeated settlement cannot notify the same intent again.

Finish pending settlements before downgrading. Older builds may discard their
metadata during database repair or drop acknowledged notices while rewriting
session records, even when the schema version is unchanged.
See [Database schemas](/reference/database-schemas) for downgrade precautions.

## Graceful restarts drain first

Startup migration warnings do not prevent the Gateway from starting. It logs the
warnings once and starts degraded. `openclaw status` and `openclaw doctor` show the
running Gateway's warning report. Read-only operators receive the repair hint.
Warning details are restricted to administrators and startup logs.
Run `openclaw doctor --fix` against the same
state/config, then restart the Gateway. Unfinished migrations remain pending for
a later startup. Errors that leave required state unsafe to read still stop startup.

A requested restart (`openclaw gateway restart`, a config change that requires
a restart, or a gateway update) does not kill in-flight work immediately. The
gateway stops accepting new work, then waits for active agent turns and
background tasks to finish, up to a drain budget (5 minutes by default). Most
restarts therefore interrupt nothing at all.

A confirmed unavailable child Node runtime follows this same graceful drain when
the effective native service command's Node can still start. The lifecycle owner
requests a fresh-process supervisor handoff once; it never uses the in-process
restart fallback for a broken retained runtime. If the service runtime is also
broken or the latest shutdown records runtime recovery within five minutes, the
Gateway stays up with degraded readiness for operator repair. See
[Runtime health](/gateway/health#http-probes) for the health fields and report-only
cases. A handoff failure after shutdown begins requires a service-owner restart.

On Linux, shutdown closes idle pooled database readers through IPC before closing
their spawn broker; active readers retain the existing cancellation grace.

CLI shutdown drains process-wide work. Closing an individual Gateway drains its
own active chat runs and queued turns, and waits on the process-wide pending-reply
count. Both report remaining work as named counts; categories can overlap and
should not be added as distinct turns. These drain waits use elapsed time, so a
system clock correction does not shorten or extend their wait budgets.

Shutdown rejects new requests before canceling admitted turns. Their in-process
Gateway binding remains available until execution and finalizers settle, so
interrupted inputs can preserve recovery state before the instance is retired.
Worker reconciliation also cancels recovery waiting for session admission;
provider operations and writes that already started still finish before teardown.

Transcript index reconciliation gets five seconds to finish during final cleanup.
After that, shutdown logs the stalled worker, cancels further projection work,
and terminates its native task. It still waits for accepted writes and database
lease cleanup before closing agent databases. Committed transcripts remain intact;
unfinished index work is rediscovered after restart. Idle pools close immediately.
This also applies to update restarts once the running Gateway contains this fix.

When Gateway connection shutdown begins, session observer event subscriptions
stop before the observer closes. Accepted observer work still settles, while
chat events and terminal session writes continue through their own drain.

If database closure refuses a follow-up drain, the drain parks its queued input
instead of retrying against the closing owner. A fresh drain request can resume
it after database admission reopens; durable input recovery owns restart replay.

Read-only RPC waits (`agent.wait`, approval decision waits, `question.waitAnswer`,
and `device.scopes.waitUpgrade`) stop observing when their client disconnects.
When shutdown drain begins, connected waiters receive retryable `UNAVAILABLE`
errors with reason `gateway-restarting`, so clients can reconnect and wait again.
These waits do not consume the stop drain budget. The underlying runs, decisions,
and admitted writes keep their normal drain and recovery behavior. This also
applies to update restarts once the running Gateway contains this fix; installing
new files cannot change a wait already held by an older Gateway process.

For an accepted WebChat turn, `agent.wait` reports `pending` with
`timeoutPhase: "queue"` when queue admission completes, including when the wait
began before admission. Queuing does not complete the turn's run ID.

Cron shutdown gives execution cleanup and durable result writes the same cleanup
window. Finishing the job's execution does not by itself complete the drain:
result persistence must also settle, or the Gateway reports the remaining work
when the window expires. Exit-watcher failures are reported after these drains
settle.

On Linux and macOS, this also applies when startup recovers from an unsupported
Node version and the service manager tracks a launcher parent. The launcher
forwards the stop signal and waits for the serving Gateway to drain within the
shared service budget. Managed restart intent targets the live serving owner,
so unfinished work still follows restart recovery when its drain budget expires.
When launchd drives the stop, macOS uses the running job's own `ExitTimeOut`, capped
by the launcher's own stop timer when a launcher is in the path, and Linux units use
their own stop timeout; both are described in the deadline sections below.
This requires a Gateway started with the updated launcher: replacing files cannot
change a launcher that is already running. On macOS, a marked launcher parent
keeps a conservative 19-second child deadline because its existing markers do not
identify whether it loaded the old or new stop policy.

For these managed restarts, if the CLI cannot verify the service command, serving
owner, or restart-intent recording, it refuses the restart before signaling with
`GATEWAY_RESTART_PREPARATION_REFUSED`. Restore service inspection or state access,
verify Gateway status, and retry. An unverified launcher PID is never a fallback.

Running 2026.9.4 Gateways remain eligible through their published state-local lock
identity. The CLI verifies the service installation, live process start identity,
and membership in that native service before preparing the restart. Stale or
mismatched identities cannot authorize a running-service restart. An inactive
service can still start without restart intent once the prior owner is proven dead.

On Linux, the systemd unit must use `KillMode=mixed` so the initial stop signal
reaches only the Gateway. Systemd still kills remaining child processes when the
Gateway exits or its stop deadline expires. Older `KillMode=control-group` units
signal child runtimes immediately, which can interrupt a turn before drain finishes.
The spawn broker stays available while its Gateway connection is alive, even if
it receives the stop signal too, so cleanup can still launch commands and observe
child exits. This does not protect other child runtimes; `KillMode=mixed` remains
required.
Updates and `openclaw doctor --fix` refresh outdated OpenClaw-managed Linux unit
policy. Maintenance reads the resident shutdown budget from Gateway status.
Older Gateways without that fact follow the short-budget path: fence admission
and observe lifecycle drain until idle or the update step deadline. At the
deadline, outstanding write custody refuses the stop with its owner phase;
remaining turns can be interrupted with a recorded warning.
Operator-owned drop-ins must be inspected and updated separately because reinstalling
the base unit preserves them. See [Linux services](/platforms/linux).

### Maintenance custody observations

Gateway `status` reports its process-owned `shutdownBudget`, with `activeWork`
counts and a separate `writeCustody` array. Suspension preparation and status
responses also include optional `writeCustody` entries with `phase` and `count`.
Current phases identify migration, backup, coordinator writes, session lifecycle
mutation, and terminal persistence. These are recorded by their operation owners;
ordinary root requests and cron runs do not imply write custody. Counts can overlap.

The optional field is additive. Older Gateways, including published 2026.9.5,
can omit it. Missing custody information never refuses maintenance. If the update
step deadline expires, maintenance stops with a warning that includes the latest
root-request and cron-run counts, explains the resident's missing distinction,
and identifies the next Gateway's refreshed stop policy. Only a reported live
write-custody phase refuses that deadline stop.

### Systemd stop deadlines

At startup and when accepting shutdown, the Gateway reads its running systemd
unit's effective `TimeoutStopUSec`, including drop-ins. It logs the source and
reconciled stop budget at both points, so a repaired unit takes effect without
restarting first. Inspection and any wait for startup to finish consume the same
shutdown deadline. Active-work drain uses at most
315 seconds for requested restarts, with up to 10 seconds reserved for final chat writes and server cleanup
and up to another 5 seconds before systemd's deadline. For a requested restart, a unit with the default
90-second stop timeout gets a 75-second drain and an 85-second Gateway
shutdown deadline. A shorter supervisor timeout also caps requested restart waits.

An ordinary stop (including `systemctl restart` without a managed restart intent)
gives active runs at most 20 seconds to finish before recording recovery and
interrupting execution. Unfinished tasks remain eligible for the next startup. Final
chat writes, worktree lease release, checkpointing, and database close retain the
remaining native shutdown budget. Shutdown settles received work and stop hooks
before full harness disposal, then joins worktree leases before worker retirement,
so a run's finalizer can release its lease. Code cells are cancelled before received
work is joined. This avoids a
lease join blocking the teardown needed to complete it. A clean database close
also avoids a stale-lease integrity scan on the next startup; an interrupted close
still requires that scan.

On Linux, process supervision reaps exited adopted children while the Gateway is
still running, so child cleanup does not have to wait for the Gateway itself to exit.

If shutdown remains blocked on `restart.close.session-effects`, its pending-close
diagnostic reports the remaining effect count and the first retained effect's
session, run, admission phase, and interruption state. The details advance as
effects release; a cleared source does not imply its retained effects have finished.

The Codex native-profile recovery warning runs as service-owned background work.
It does not hold readiness while another agent's database admission finishes.
Doctor still awaits the same diagnostic, and shutdown joins any diagnostic reads
that already started.

Both allowances are bounded when the deadline cannot fund them, by the same rule the
launchd budget uses and for the same reason: subtracting two values sized for a
315-second drain from a short stop timeout consumed it entirely and left active work
nothing. A unit whose `TimeoutStopSec` is 20 seconds or longer keeps the allocation it
already had, less whatever the stop inspection itself cost, rather than to the exact
millisecond: 20 seconds is only the least that funds the full 10-second reserve
alongside a 5-second drain before that cost comes off. Below that the deadline cannot fund
both, and the reserve yields to keep a drain: a unit at or below 15 seconds now drains
at all where it previously drained for zero milliseconds, and the four values between
trade part of a reserve for a drain that was under 5 seconds. The reserve never falls
below half the shutdown budget. The exit margin holds its full 5 seconds down to a
20-second deadline and shrinks below that, to 3.75 seconds at 15 seconds and a quarter
of anything shorter. The drained work, ordering, and interruption behavior stay the
same, and systemd's own 90-second default is unaffected.

Service-child cleanup uses the remaining Gateway shutdown budget, leaving time
for final exit bookkeeping. A forced restart drains admitted work within the same
budget. Expiring the restart scheduler's idle deferral starts the normal drain:
new work is fenced and admitted work gets the computed grace period, still capped
by the native shutdown deadline. Deferral time does not spend that shutdown budget.
For a supervisor's SIGTERM restart, a shorter requested drain limits when active
runs are interrupted, not when database cleanup must finish: cleanup can use the
remaining native stop budget. After an interrupted external restart, the Gateway
joins final chat persistence, drains Memory's database borrows, and closes agent
databases before exiting. It skips plugin and channel teardown that could retain
the process until the deadline. Database admission stays fenced through lock
release and log flushing, which have a final five-second exit window. Shutdown
logs report each cleanup step that takes at least one second, including its name
and elapsed milliseconds. While cleanup remains pending, a normal info-level report
every five seconds lists the pending wait count, names, and elapsed times, including
worker reconciliation already in progress before shutdown. Deadline exits also list the currently pending cleanup steps
and how long each has been waiting (up to eight, with a count of any others).
These diagnostics are always enabled; `OPENCLAW_GATEWAY_RESTART_TRACE=1` adds
begin/end timing for fast steps too. The supervisor deadline remains
the hard upper bound. Clean database restart proof is published only after writer
leases, checkpointing, and native connection closure settle; one database's idle
receipt alone does not authorize process exit.

Session-admission diagnostics distinguish source cleanup from effect admission.
Pending source cleanup includes live counts of sources, operations, and retained
source work. A failed final response does not retain a source after its runtime
confirms completed disposal, even when disposal also reports a callback error.
Unfinished disposal still retains its cleanup obligation.

Worker-placement and environment reconciliation stop admitting new candidates
when suspension or drain begins. Releasing a suspension allows the next scheduled
sweep to resume. Suspension, drain, and service shutdown also cancel in-flight
environment reconciliation. Provider inspection has a 15-second budget, while
runtime installation keeps its transfer-sized bootstrap budget. Late inspection results
cannot resume reconciliation or hold the shutdown guard. Interrupted maintenance
retains the lease and provisioning identity for a later sweep; it does not request
worker destruction. Provider mutations already in progress still settle before
their owners close.
Reconciliation also passes cancellation into provider teardown, including Crabbox
image capture and stop commands. Teardown's provider deadline aborts the command;
shutdown still joins its subprocess settlement and records the interruption. An
unconfirmed stop retains the lease and cleanup intent so the next startup retries
the same environment. Pending replies and terminal persistence keep their normal
drain obligations.
Rejected background environment reconciliation waits one minute before retrying,
then doubles the delay up to fifteen minutes. The warning records the attempt
count and next retry time. This delay applies before placement and workspace
recovery, independently for each environment; healthy environments continue normally.
Explicit recovery stays immediate. Successful recovery, changed lease ownership,
state or destruction intent, and a new Gateway process reset the delay. Suspension
and shutdown interruptions do not count as failed attempts. Durable cleanup intent
and the separate session-attachment cleanup retry owner are unchanged.
Read-only allocation lookups made by reconciliation also release their wait on shutdown, without
publishing a late lookup result or changing the saved cleanup intent. Reconciliation
waiting for an environment lock releases its observer on cancellation; any admitted
mutation keeps its settlement owner. Placement sweeps stop waiting for optional
environment observations as soon as service shutdown begins, allowing transport
cleanup to proceed while the environment service drains accepted work.
Optional session-evidence reads and disk probes are canceled. Node retention stops
new preparation and cancels supported requests; an in-progress shared bundle
build remains joined. An accepted retirement, workspace recovery, reclaim, or
publication effect still settles before its database or transport closes. A later restart
resumes deferred maintenance from durable state. Deadline diagnostics name the
pending placement subphase, such as
`shutdown.worker-placement.reconcile.session-retirement`, `reconcile.active`, or
`reconcile.publications`. These joins keep the worker transports and shared
database available until accepted effects have recorded their outcomes.

Worker-environment shutdown also names its computer, inference, transfer, tunnel,
and accepted-operation joins. Closing the service cancels a pending reconciliation
owner lookup through the database reader before joining the guard; an idle lookup
does not wait for the process shutdown deadline. Admitted recovery effects still
settle before their owners close. After cancellation, reconciliation skips fresh
placement scans and retention writes; the next boot resumes from durable state.
Pending diagnostics distinguish attachment reconciliation, environment reconciliation,
environment-lock and inventory waits, installation and credential preparation, and
provider calls (including inspection, allocation lookup, provisioning, teardown, and
SSH identity resolution). Environment and provider identifiers accompany these waits.
They also distinguish
retention writes, candidate reads, and session recovery. For an attached worker, shutdown stops the exact
remote environment before draining its workspace queue: a foreground command
can hold that queue until the stop cancels it. Remote stop, drain, and active-turn
cancellation acknowledgments and native computer close requests share at most five seconds after shutdown begins,
capped by the remaining process cleanup budget, including cancellation already
started before shutdown. Tunnel cleanup separately times initialization, active
launches, workspace operations, and transfers, so a slow reconciliation join names
the work it is waiting for. An unreachable worker keeps its durable attachment
for cleanup on reconnect; it is not reported
as physically stopped. Local writes and transfer cleanup still settle before
database retirement.

The core `shutdown completed` message precedes final process cleanup. Slow-step
diagnostics continue through managed local services, snapshot cleanup, log
flushing, watchdog retirement, and shared-state closure, so a delay after that
message can be attributed to its remaining owner.

A restart without a supervisor handoff uses the existing shutdown
deadline for cleanup. This includes foreground Gateways inside another service's
cgroup, restarts with `OPENCLAW_NO_RESPAWN=1`, and standalone updates that must
launch their own replacement. Cgroup membership alone does not provide a supervisor
that will replace the Gateway. Ordinary
cancellation keeps its five-second grace before forced termination. During
shutdown, a relay that needs forced termination after its owned processes are
confirmed gone produces a warning. Completed cleanup leaves the Gateway's exit
status at zero; an unconfirmed process cleanup boundary still reports failure.

The process's cgroup selects the system or user manager, independently of the
account running the Gateway or its restart owner. This also covers hand-written
system units with `User=openclaw` and externally managed deployments. Reading
the system unit's timeout does not require sudo or notification support.

If the unit cannot be inspected at startup, the Gateway warns with the manager,
unit, and failure reason and uses systemd's 90-second default as a conservative
fallback. A failed shutdown reread retains the startup budget, with elapsed time
deducted, instead of assuming a longer timeout. An explicitly unlimited timeout
keeps the normal Gateway budget. Already-running `v2026.9.5` Gateways retain their
startup reading until they restart; installing newer files cannot change the
shutdown budget captured by that older process.

An already-installed old unit benefits from the clamp as soon as the new Gateway
starts, without a service rewrite. This leaves time for orderly shutdown instead
of spending the entire stop window in drain. Work that cannot settle still uses
the existing interruption and recovery path; the shorter budget cannot guarantee
that arbitrary cleanup completes. CLI installs and guided Doctor service repairs
render `TimeoutStopSec=330` from the same policy as the Gateway. Doctor reports
an effective stop timeout below that requirement. Operator-owned drop-ins remain
the operator's responsibility.

For hand-written system units, allow at least **drain + 15 seconds**. With the
current maximum drain, create
`/etc/systemd/system/openclaw-gateway.service.d/stop-timeout.conf`:

```ini
[Service]
TimeoutStopSec=330
```

Run `sudo systemctl daemon-reload` and verify with
`systemctl show openclaw-gateway.service -p TimeoutStopUSec`. Restart through your
service's deployment owner. For a user
unit, use `systemctl --user edit openclaw-gateway.service` and the corresponding
`--user` reload/show commands. Retain `KillMode=mixed` as described above; a longer
timeout does not protect children from `KillMode=control-group`'s initial signal.

Replies to pending node commands remain accepted during the drain, including
worker cleanup started by shutdown. Each reply must still match its live
invocation, node connection, pairing generation, and owning lifecycle. This
lets cleanup finish without waiting for a command timeout. It does not reopen
admission for new requests.

Operators can also inspect and answer pending questions or resolve approvals
while the Gateway drains. These requests must belong to still-pending work
admitted before shutdown; normal authorization checks still apply. New question
and approval requests remain fenced.

Work that cannot finish inside the drain budget is marked for recovery before
the shutdown owner aborts it. The close prelude fences new request entry and
background producers without canceling received execution or retiring its internal
principals. The run-shutdown owner records recovery, then cancels queued turns,
replies, and received execution before disposal starts. This keeps the live admission
available to the recovery marker instead of depending on already-released owners.
A prior restart cancellation does not remove a still-owned run from the marker's
candidates. If no supplied candidate can be marked, a warning reports the counts
and dominant skip reason.

Restart cancellation also preserves recoverability when the bulk shutdown marker
cannot be written. Native runtime preparation interrupted by the same Gateway
restart is recorded as restart cancellation rather than a provider failure.
Explicit user cancellation and genuine execution timeouts
remain terminal. Recovery startup uses the admitted run's existing deadline,
including runtime preparation and waiting for session or global capacity. Waiting
in a healthy queue does not consume separate failed-start attempts. A resend whose
start times out before its turn begins is a failed start: the charged attempt stays
owed and is retried within the budget below.

`sessions.abort` waits for the cancellation's session write before acknowledging
success. Restarting immediately after that acknowledgment preserves the terminal
outcome even if the run's finalizer has not finished.
This also applies to a parent that yielded while waiting for spawned tasks:
successfully stopping its children records the captured parent's cancellation
before acknowledging, without overwriting a newer turn in that session.
If another child cannot be stopped, the response still reports incomplete
cancellation; the captured parent's cancellation is persisted before that error.

### Launchd stop deadlines

On a launchd-driven stop, the macOS Gateway reads the **loaded** job's effective
`exit timeout` with `launchctl print`. It checks the system, GUI, and user
domains, and accepts only a job whose PID is the Gateway or its launcher. Restart
ownership can still be external: the supervisor that enforces the stop, not the
owner of the next start, determines the deadline. A direct SIGTERM does not start
launchd's stop clock, so it keeps the existing Gateway stop policy unless an
OpenClaw launcher independently enforces its own child reap timer.

The **stop budget** is time available until the supervisor can kill the process.
The Gateway sets aside an exit margin (up to 5 seconds) and plans its shutdown
inside the remainder. **Drain** is the first part of that shutdown: stop admitting
new work and wait for active turns and background tasks to settle. The rest is
reserved for final writes and service cleanup (up to 10 seconds). The Gateway
logs the chosen source, drain, shutdown deadline, reserve, and exit margin.

New LaunchAgent plists request `ExitTimeOut=330`, derived from the same service
stop budget as Linux's `TimeoutStopSec=330`. With that effective deadline, the
nominal split is 315 seconds of drain, 10 seconds for cleanup, and 5 seconds before
the supervisor deadline. `openclaw doctor --fix` backs up and migrates the retired
installer value of 20 seconds to 330 only when the definition otherwise matches
the retired generated template. A 20-second timeout in a customized definition
is ambiguous: Doctor reports that it is below the drain budget and preserves it.
An installer comment alone does not authorize replacing an operator's policy.
Other explicit values, including 600 and
unlimited (`0`), are reported and preserved; short custom values receive a warning.
Update finalization uses the same backed-up service reconciliation. The first
stop still obeys the previously loaded job's deadline until the replacement is
bootstrapped.

Time spent inspecting the job is debited. A legacy 20-second job nominally leaves
5 seconds of drain, 10 seconds for cleanup, and a 5-second exit margin. For a shorter custom deadline the exit
margin is at most a quarter, and the cleanup reserve gives way to leave active
work up to 5 seconds of drain (at most half of the remaining shutdown budget
when it is very short). For example, a 5-second job nominally leaves 1.875
seconds each for drain and cleanup after its 1.25-second exit margin; a
15-second job leaves 5 seconds of drain, 6.25 seconds for cleanup, and a
3.75-second margin. **This reduces cleanup time for custom jobs below 20
seconds.** The default systemd 90-second deadline is unaffected. The check can
consume up to three 2-second calls; a very slow inspection can leave no drain.

If a Node-recovery or compile-cache launcher is the job's PID, its own child
reap timer may be shorter than launchd's deadline. The Gateway caps its budget
at that timer only when its respawn markers establish that this launcher started
it; an unrelated parent does not shorten the budget. New launchers use the shared
330-second service budget, but the child conservatively retains the older
19-second launcher cap until a parent runtime-generation contract can distinguish
already-running launchers. Raising the plist value alone does not remove that cap.

A direct signal to a marked launcher can start its own timer while launchd
still reports `running`. The Gateway cannot distinguish that forwarded signal
from a direct signal to its child, where the launcher has no timer, so it does
not cap this case. Operators stopping a launcher directly should use the loaded
job stop instead to get an enforceable, reported deadline.

`ExitTimeOut=0` means no launchd stop deadline, not a missing value. Without a
launcher timer, the Gateway keeps its ordinary policy and does not classify the
job as a native deadline. An unreadable job leaves
the existing stop policy in place with a warning, while a confirmed stopping
job whose timeout is missing uses launchd's 20-second default with a warning.

The value comes from the job launchd has **loaded**, not the plist on disk.
Editing `ExitTimeOut` or running `launchctl kickstart -k` does not reload it;
`launchctl bootout` followed by `launchctl bootstrap` does, restarting the
Gateway. Reading per stop avoids a stale startup snapshot, not a stale loaded
job. On macOS 27, launchd reports at most 60 seconds even if the plist asks
for more; inspect the loaded job to confirm the effective value.

## Host sleep and process freezes

When a gateway host wakes from sleep, a virtual machine resumes, or the process
continues after a long pause, the gateway detects the freeze within about 30
seconds. It restarts channel connections once tracked Gateway work is idle, then
refreshes cached health and presence. The health and presence refresh still runs
when a busy gateway defers only the channel restart. This keeps stale sockets from
waiting for their normal expiry without interrupting an active reply or agent
startup when a busy event loop caused the timer gap.

Sleep and backward wall-clock adjustments do not by themselves revoke state
ownership. After a heartbeat gap, the Gateway verifies its lock's physical
identity and acquisition bytes before renewing it. A removed or replaced lock,
or a renewal that still fails, fences state access. Locally authorized recovery
still restarts the Gateway when the fenced database cannot supply the stored
restart intent; raw unauthorized restart signals retain their existing policy.
No configuration or database migration is needed when updating to this behavior.

The macOS app and Linux companion cooperate with a local gateway by preparing a
short suspension lease before the host sleeps and resuming it after wake. Remote
gateways are not suspended when the app host sleeps. A deliberate suspension
through `gateway.suspend.*` keeps recovery deferred until the controller resumes
the gateway.

## Recovery after a failed update

After a failed interactive update or repair, OpenClaw finishes cleanup and any
service recovery, then opens [`openclaw triage`](/cli/triage). Triage immediately
starts the first directly launchable coding agent in this order: Claude Code,
Codex, OpenCode, then Pi. It passes the captured failure before fresh Doctor
checks or archive collection and asks the agent to diagnose, repair, and verify
the installation. The agent receives the captured installation paths and keeps
its normal authentication, sandbox, and approval settings.

For a failed Control UI or unattended update, use the installation-specific
command printed on the Gateway host, or run triage there with the same OpenClaw
profile and state/config paths. Use `--agent` to select a particular coding agent:

```bash
openclaw triage
openclaw triage --agent codex
```

JSON, `--yes`, and non-interactive update invocations collect diagnostics without
starting an external coding agent. `openclaw triage --non-interactive` also prepares
diagnostics without launching an agent. `--update-result <path>` includes an
updater's saved failure artifact. Printed handoff commands preserve installation
selectors and use PowerShell on Windows or POSIX shells on macOS, Linux, and WSL.

Staging and validation run while the old Gateway serves. The candidate runs
Doctor lint, config and plugin planning, and an isolated canary boot against
copied configuration and verified database snapshots. Migrations on these
copies rehearse the upgrade without changing live state. A validation failure
can enter [bounded unattended repair](/install/updating#unattended-repair-on-your-own-inference)
while the old Gateway keeps serving. Activation requires the failed check to
pass. Otherwise the candidate is discarded. An `already-current` no-op never
stops the Gateway.
Older targets that predate migration continuation record runtime validation as
unavailable and use the [existing downgrade finalization path](/install/updating#roll-back-a-package-install).
The detached helper also waits for the `activating` phase before parking its
parent Gateway. The first activation window contains the swap, required live
migrations, and service start. Plugin package download and sync run while the
core Gateway serves. A changed plugin snapshot requires a second measured
activation window: full Doctor migrations under exclusive maintenance, then
restart and verification. Unchanged plugins do not run another full Doctor pass.

After activation, the updater verifies that the managed service is running and
owns its port, the Gateway hello handshake matches the expected version/build
identity, health checks pass, plugins and channels are healthy, and
`/readyz` returns HTTP 200. Update verification does not use model inference.
Startup receives the update's existing per-step `--timeout` budget (1800 seconds
by default), including migration, listener initialization, and readiness checks.
On the first update from an older release, the old updater
invokes the newly installed CLI but does not pass that readiness budget. The
candidate recognizes the existing update marker and, once the managed process is
running, uses the five-minute startup watchdog instead of the standalone
60-second deadline. Migration, listener, and health transitions do not reset this
bound. The old updater's subprocess timeout also remains in force. An exhausted
wait reports the last observed startup phase. Standalone restarts use the [progress-gated readiness wait](/cli/gateway/restart-and-supervision#restart-the-gateway).
Verification facts and measured downtime are retained in the
[update run report](/cli/update#run-history-and-reports).

When a package fails verification, the updater compares the shared and affected
per-agent SQLite `user_version` values and configuration content with their
pre-activation values. If they are unchanged and the previous runtime was
verified before activation, it restores the previous package, command shim,
service definition, and config writer stamp, then starts that runtime and repeats
the CLI verification checks. Successful recovery leaves that Gateway running
and finishes `rolled-back`, with the failing check kept as the reason and
downtime covering service stop through verified recovery. The writer-stamp guard
does not block this intentional recovery. Its allowance is scoped to rollback
service commands and never persisted. See
[Automatic rollback](/install/updating#automatic-schema-neutral-rollback).
If configuration content or a schema version changed, automatic rollback is
refused (`state-migrated-no-rollback`) and the updater attempts bounded repair on
the installed candidate. The same repair slot can run when rollback itself fails.
Code rollback cannot reverse state migrations. An unavailable schema comparison also prevents
automatic rollback (`rollback-state-unverified`). After migration,
a fresh candidate process finishes verification and the same durable run report.
The old updater does not reopen the newer database. Git activation failures before live migrations can restore
the previous source and retained built runtime. Later Git failures retain the
candidate for diagnosis.

An update failure does not by itself authorize a candidate restart. Candidate
activation still requires successful validation. A blocking live Doctor result
does not become a restart grant. The previous runtime was verified before the
update, so rollback across unchanged configuration and schemas may restart it
under that prior verification and must verify it again afterward. A detached
helper or Windows task autostart cannot bypass this decision.

During post-activation repair, the orchestrator starts or restarts a stopped or
unhealthy service once after each turn, then reruns verification. Passing checks
allow the run to succeed. If rollback already restored the previous release,
successful repair finishes `rolled-back` and the command still exits nonzero.
Otherwise it fails with the original reason and repair summaries. The agent
cannot issue service lifecycle commands.

On Windows, captured Scheduled Task autostart stays suspended through Doctor
finalization. The updater enables the task for activation and restores
suspension if final verification fails, including after a migrated-state handoff.
Native task-control failures appear in the update report. Failed suspension
never triggers automatic re-enablement of the rejected installation.

On macOS, a terminated update helper can leave the selected Gateway LaunchAgent
installed but unloaded and disabled across logins. `openclaw doctor` and
`openclaw doctor --fix` diagnose this state. After successful standalone repair,
`--fix` starts and verifies an already-stopped managed Gateway whose service
targets the current installation. Update-time Doctor leaves activation with the
updater. If the update was interrupted or installation safety is uncertain,
rerun `openclaw update` or use Doctor and triage before starting it manually.
Once verified, run `openclaw gateway start` (or
`openclaw --profile <profile> gateway start`) to re-enable and start that service.
Keep the same state/config and custom-label overrides. Doctor prints the selected
label and recovery command. Interactive Doctor can offer bootstrap repair.

A cancellation before package mutation can restore the original service under
its existing handoff ownership. Recovery succeeds only after the Gateway passes
the normal restart health checks and reports the verified installation version
and, for Git recovery, the exact restored build ID. A matching package version
alone cannot distinguish two Git builds. A service
manager accepting a start request, or reporting a live PID, is insufficient.
Once the detached helper launches the updater, a missing, malformed, oversized,
or interrupted direct result leaves activation to the operator. This is stricter
than older helpers that restarted after an unclassified failure. Installing a new
target does not change an already-running historical helper. These checks apply
to the helper version that started the update.

A skipped update before activation does not park or restart the Gateway. If an
interruption occurs after parking, the helper uses the child's verified recovery
decision and preserves the original reason. A zero exit is retained only if
required recovery succeeds or the child already verified it.

Updater exit code `79` keeps the Gateway parked only when the previous generation
cannot be safely restored and verified. When the updater has restored the previous
generation across unchanged configuration and schemas and supplies a verified
recovery decision, the helper starts and verifies it instead of leaving it
stopped. Helper recovery verifies service liveness, version/build identity,
plugin activation, and channel health. It does not repeat the separate `/readyz`
check. That report field remains unverified.
The run then finishes `rolled-back` with the previous version and measured
downtime. Missing recovery proof, migrated state, or failed restoration still
requires repair before restart. A service that is observed stopped is recorded
as stopped. The report does not reuse its pre-activation running status.

A terminal failed update still exits nonzero when later service recovery or
triage repair succeeds. Error and skip notifications are attempted before recovery. The helper
does not recreate them after the recovering Gateway consumes them. Check the
final CLI result and the handoff log for the recovery outcome.

Repair the failed Doctor or installation check before restarting. Triage can
inspect `openclaw gateway status --deep` and the update diagnostics. Avoid blindly installing
older code after a newer release has migrated configuration or databases. See
[Updating and recovery](/install/updating). Restart sentinels report the outcome.
Copying one does not grant permission to restart a service.

## How interrupted work is detected

Persisted session status records only a run outcome: `done`, `failed`, `killed`,
`timeout`, or `interrupted`. A new run clears the previous outcome; session rows
derive `running` and `queued` from the live run registry and queue owner.
Restart-aborted runs record `interrupted`, an interruption reason, and their end
time while retaining the recovery owner's claims.

New input follows the live reply owner's queue policy. Without a live reply, durable execution
fences must have terminal evidence before admission can retire them. Successful
final delivery clears its pending intent and any unclaimed recovery route while
preserving newer execution or delivery claims.
Message-tool text and managed media already committed to WebChat history do not
by themselves create another pending final delivery during turn completion.
Other payload content and later additions, such as Connect buttons, generated
speech, or usage footers, retain their delivery custody.

Before readiness, startup invokes the shared Doctor transform to normalize older
persisted `running` or `queued` values to `interrupted` once, except verified legacy
yields retain an unset outcome so their child continuation keeps ownership. It logs
the repaired count, preserves recovery claims and transcripts, and retains activity timestamps.
Eligible legacy `running` entries without a claim receive recovery custody before
their old status is removed, preserving their existing automatic resume path.
The saved end time is preserved or falls back to the entry's last durable update.

Archiving drains and cancels the session's work before committing the archive.
Existing run outcomes, recovery receipts, and pending delivery metadata remain
intact; restoring an archived session does not resume its cancelled execution.
Unarchived main sessions retain their separate resume path below.

Three complementary mechanisms mark sessions whose turn did not finish:

- **At turn admission:** for an ordinary text turn on an existing main session,
  the gateway appends the user message, clears the previous outcome, and records
  its recovery delivery claim in one SQLite transaction before model or
  `before_agent_reply` hook execution. Control UI does this before returning the
  `started` acknowledgement. Channel dispatch does it when the prepared turn
  adopts the agent run.
  Turns without a channel delivery route also acquire a durable recovery claim
  in that admission write; the claim does not grant channel delivery authority.
  Commands, attachments, per-turn overrides, pending deliveries, prior abort
  hints, plugin-owned sessions, and turns with execution hooks keep their
  specialized admission paths.
  If a `before_agent_reply` hook is installed, admission records enough phase
  state to distinguish a completed silent result from an ambiguous side-effect
  window. Recovery dispatches an ordinary user-triggered agent turn, so the
  currently loaded `before_agent_reply` hooks run under their normal trigger
  rules. Ambiguous prior hook outcomes resume with restart-safe tools rather
  than replaying unrestricted side effects.
- **At shutdown:** every session with an active run is stamped with a recovery
  marker before the shutdown owner aborts it. Runs already cancelled for restart
  remain candidates, even if connection cleanup ran first.
- **At startup:** the Gateway scans recovery-owned claims and main sessions with
  `abortedLastRun: true` or an `interrupted` outcome, even without a claim. With
  no live owner in the new process, the existing recovery owner creates the
  missing cycle and resumes the turn. This safety net covers missed or failed
  shutdown markers, hard crashes, and kills where no shutdown code ran. Archived
  and tombstoned sessions stay excluded; pending delivery, yielded continuations,
  and retry budgets retain their existing owners and rules. A newer user turn
  clears the prior interruption and is not replayed. Stale transcript lock files
  are cleaned up at the same time.

Startup selects these candidates from the active-session index in the session
database worker without reading transcripts. Candidate discovery skips archived
rows, and unrelated session summaries do not cross into the Gateway process.
Pending canonical validation still runs when no recovery candidate exists, and
marking rechecks the current row and live ownership before committing.

Agents still undergoing database startup inspection retain their recovery work.
When admission finishes, the same startup recovery owner scans their stores with
the original cutoff, so newly admitted turns are not mistaken for crash orphans.
Inbound channel turns, including unacknowledged messages replayed after a crash,
wait for their agent's writable admission before recording session metadata or
dispatching. Other agents remain available, and stopping the channel or Gateway
cancels the wait.

A failed store scan leaves that store eligible for the scheduled retry while
other stores continue recovery. `openclaw status` and `openclaw doctor` show
outstanding startup recovery failures from the running Gateway; the warning clears
when the store scan succeeds.

A restart abort preserves the interrupted turn's recovery claim even when command
cleanup finishes before shutdown marking. The Doctor transform also restores a
missing claim for an older interrupted internal chat writer when its recorded
terminal marker has no matching delivery evidence. Existing completed-turn
receipts remain intact; recovery uses its normal transcript replay checks.

If a Gateway left a dead writer and an unfinished recovery cycle,
`sessions.recover` reconciles that writer
and starts a continuation in the same session. New Control UI and channel messages
also reconcile this state before admission, so a rejected send cannot trap the
conversation in a "conversation changed" retry loop. Channel messages wait behind
live recovery ownership and resume admission when it settles. These paths preserve
the session key and transcript. A live run or cloud worker still prevents this repair. Tombstoned
sessions retain their separate recovery path into a new session.

If recovery fails during preparation before the agent starts, the Gateway restores
the interrupted state and releases that attempt's delivery claim. The next recovery
attempt uses a fresh run ID while retaining the original interrupted turn and retry
budget, so a rejected pending input cannot leave the conversation permanently busy.
This includes an accepted continuation refused by shutdown before its runtime turn
starts. Its charged attempt remains in the same retry budget across startups;
exhaustion still produces the normal recovery notice.

## Automatic resume

A few seconds after startup, the gateway re-dispatches each marked session
with a synthetic system message telling the agent its previous turn was
interrupted by a restart and to continue from the existing transcript. If a
final reply had already been produced but not delivered, its text is included
so the agent can deliver it instead of redoing the work.

Startup recovery prepares continuations in interruption-time order across session
stores, separately from execution. Preparing the next continuation does not wait
for the previous turn's execution or source settlement. Automatic continuations
execute in a dedicated restart-recovery command lane with up to four turns running
at once. Each session still runs one turn at a time, and each recovered turn retains
its lane slot until it finishes. Interactive turns and unrelated background work
keep their own execution slots. Later interrupted turns retain their durable
claims while waiting for recovery capacity. Transient startup or store-admission
failures use bounded backoff without clearing those claims.

When a new user message or a retry of an accepted chat turn initiates recovery,
that recovery uses the main lane for both admission and execution. It does not
wait behind unrelated background work. Existing recovery owners are not
preempted, and normal main-lane concurrency limits and per-session ordering
still apply. Detached queued followups and unattended retries use the
restart-recovery lane. This changes only in-process scheduling, not stored recovery
claims, retry budgets, configuration, or upgrade behavior.

Optional startup database maintenance and page-cache warming wait for this
backlog to drain; runtime timers and cron startup proceed independently. Deferred
database admissions join the same startup scheduler. Shutdown stops new preparation and
joins the current pass, leaving unstarted interruptions available for the next boot.

Recovery follows retained transcript-window ownership when a session moves to a
new key or rotates its session ID. Claim validation and cleanup read only those
candidate sessions, so stale recovery claims do not load unrelated saved prompts
while interactive session changes wait. Claim authority, retry budgets, stored
data, and upgrade behavior are unchanged.

The Control UI shows a neutral system notice: “Gateway restarted. Resuming your
interrupted request.” Expected restart interruptions do not create a terminal
reply-failure card or ask you to send the request again. A restart refusal during
an active turn retains its recovery claim, even if the admission fence closes
before the shutdown owner cancels that turn. Genuine provider failures, explicit
Stop actions, and exhausted recovery remain separate outcomes.

Each resend is one ordinary input in the session's queue, so Stop,
`sessions.abort`, reset, and delete apply to it like any other waiting input.
The existing startup preparation and global execution budgets still apply;
a waiting session does not add a separate process-wide scheduling barrier.
An owed resend runs before an ordinary message that arrives on the same session
during startup; later messages queue behind it in arrival order.

A message sent with `interrupt` always wins over a resend that has not started:
the resend is cancelled and the message runs. While a recovered turn runs, an
interrupt ends it like any active turn. Steering follows the session's normal
[queue mode](/concepts/queue#queue-modes): a steer that the recovered turn's tool
permissions cannot accept, including every steer into a replay-safe turn, waits and
runs as its own turn afterward.

Stopping or interrupting a resend before it starts ends that recovery. The resend
is recorded as a stopped run, is not sent again (including after a later restart),
and does not use one of the automatic attempts described below.

The restart does not cancel the user's task. The agent checks the current state,
reconciles tool results whose outcomes are unknown, and continues without asking
the user to repeat the request. Preparing a new message cannot consume the
interruption marker; the durable recovery claim retains it until work is
adopted or settled.

Recovery reads the interrupted turn's source before starting another run, even
when a final reply is already pending. If the transcript cannot be read, the
saved reply and any admitted completion claim remain available for a later
attempt. Delegated requests and unverified internal inputs cannot resume
automatically without surviving authority. When no pending final, harness
completion, or independent recovery run remains owed, the interrupted input is
retired atomically with one local transcript notice. Its source/run IDs remain
terminal; no delivery success or sender authority is invented. The conversation
keeps its identity and context and admits a fresh authenticated turn. Remaining
custody retains the existing recovery block, and exhausted automatic attempts
still require explicit recovery. Missing or invalid provenance does not establish
a human sender for an internal claim. Legacy channel and Control UI
turns retain their existing recovery checks. Child-completion follow-ups still use
their existing recovery and delivery ownership checks. If their agent database is
still undergoing startup inspection or preparation, a child result changes while
being read, or a preparation worker refuses work at capacity, the pending completion
wake retries after 30 seconds without consuming delivery attempts or changing its
batch, replay identity, or retry counters. Each retry reads fresh results under
the same ownership checks. The retained wake survives another restart. A confirmed
inspection failure or ownership mismatch remains a failure, not permission to
bypass database admission; cancellation still retires the wake.

A failed child-completion group does not stop startup recovery for unrelated
groups. The original group keeps its ownership checks and retries with bounded
backoff; already-started restored runs are not launched again by those retries.

When a recovered turn starts with an eligible channel delivery route, OpenClaw
sends a resumption notice to that conversation, retaining its account and topic.
The final reply uses the same delivery route. Transcript-only turns stay private,
and a turn that has already finished does not receive a late resumption notice.
Channel-less turns started through the `agent` RPC remain channel-less after
recovery. Control UI and `chat.send` / `sessions.send` WebChat turns retain their
WebChat context. In-flight claims from older builds that did not record the
original channel retain the previous WebChat fallback for session keys without
an external channel route; no migration is needed.
A failed notice does not restart or replay the recovered work. Main-session
resumption notices are best-effort and live-only: automatic-delivery permission and the recovery
owner are rechecked immediately before the channel send. They are not replayed
from the outbound queue; terminal-failure notice retries and normal final-reply
delivery are unchanged.

Telegram renews its typing indicator while the recovered turn runs. Typing stops
when the turn settles, its recovery owner changes, or the gateway closes, and
respects `typingMode: "never"`. Other channels can opt in through the guarded
typing hook; unsupported channels still receive the resumption notice.

Channel plugins opt in with `heartbeat.sendTypingGuarded(...)`. Alongside the
recovery delivery target, core supplies an `AbortSignal` and an
`assertPlatformSendAuthorized` callback. Plugins must honor cancellation through
queued sends and invoke the callback immediately before the platform request,
after asynchronous preparation. Recovery does not fall back to the unguarded
`heartbeat.sendTyping(...)` hook.

Startup reconciliation retries transient failures up to three times with
exponential backoff. Separately, each interrupted main-session cycle has a
durable budget of three charged automatic dispatch attempts, retained across
gateway restarts. OpenClaw charges an attempt before dispatch, refunds it when
the gateway explicitly rejects the request before acceptance, and retains the
charge when a post-dispatch result is uncertain to avoid replaying work.
Foreground work that already owns the session keeps automatic recovery out
until that work settles.

Explicit dispatch rejections can exhaust the startup passes without exhausting
the charged-attempt budget. The interrupted session keeps its recovery cycle for
the next startup. An authorized operator can also call `sessions.recover` with
`{"key":"<session-key>"}` to continue in the same session immediately. This accepts
one new input under the operator's current authority; it does not restore the
failed dispatch's authority or replace the session. Active work and pending final
delivery retain their existing ownership checks.

If a CLI runtime cannot enforce the required restart-safe tools, recovery keeps
the cycle as a tombstone before refusing in-place continuation. The operator can
then use **Resume in new session** without losing the interrupted transcript.

Concurrent `sessions.recover` requests for that replacement return the same
successor and continuation acknowledgment. Recovery serializes admission while
preserving each caller's current authorization; it does not wait for the resumed
model turn to finish.

Definitive revocation of the original operator's authority remains terminal for
that input: recovery records one visible interruption instead of retrying it.
The same applies when a retained requester profile has no matching operator
recovery source, or the requester source no longer belongs to the interrupted
turn. A profile ID alone cannot restore execution authority. A current matching
source still resumes under the original operator's permissions, regardless of
who created the session.
When no other recovery or delivery custody remains, send a new authenticated
message to continue; `sessions.recover` does not revive that retired input.
Child sessions retain a recovery tombstone instead, and the parent receives an
interruption notice with instructions to use **Resume**. An authorized operator can use
**Resume** or `sessions.recover` on the child to continue under current authority.
Later Gateway restarts do not automatically replay the denied input.

Cancelling a recovery reservation after foreground work finishes clears an empty,
uncharged recovery record. Recovery reconciliation and foreground admission also
clear this residue from older sessions, so it cannot block a completed subagent's
requester turn. Interrupted work and pending delivery keep their recovery custody.

After the durable budget is exhausted, the session is tombstoned instead of
looping forever. The unfinished task remains available: inspect the failed
session and use **Resume** in WebChat to continue in place with current operator
authority. In other channels, `/new` or `/reset` starts a replacement.
`openclaw doctor --fix` can repair a stale aborted flag that conflicts with a
tombstone, but it does not re-enable that automatic recovery cycle. See
[Session recovery](/concepts/session#gateway-restart-recovery) for tool-safety restrictions
and the CLI-runtime replacement fallback.

If you message the failed session again in a channel, OpenClaw sends a short
recovery reminder through that channel and logs each rejected message at warn
level with the session key, recovery reason, and recovery command. Repeated
reminders are suppressed in a bounded memory cache. Resetting or deleting the
session, or restarting the Gateway, clears that suppression. Sessions with locked
model selection instead direct you to **Resume** in WebChat.

Every retry reuses one durable dispatch identifier, so an ambiguous connection
failure cannot start the same recovery twice. Completed Control UI turns also
retain bounded durable completion markers, allowing a reconnecting outbox
to retire them without re-executing the request. When the outbox resubmits an
interrupted turn whose resend is already queued, the Gateway acknowledges it
without starting a second run.

When a pending final has no remaining queue owner and its delivery outcome is
uncertain, recovery records a notice for the next turn on the same route when
the saved final has a delivery context and intent ID. Settling that turn clears
its recovery ownership together with its delivery claim, so the next agent turn
can proceed. The notice and terminal deduplication evidence survive another
restart; completed work is not replayed.

A recovery continuation for a legacy saved final without a delivery intent or
queue owner may fail terminally. In that case, recovery preserves the saved
reply in the local transcript as delivery-unconfirmed and retires its pending
marker. Later Gateway boots do not replay that failed continuation. An interrupted
continuation or a newer pending delivery keeps its own recovery ownership.

Message-tool-only replies use a second durable correlation. Before a terminal
same-conversation send reaches the channel, the gateway records an unresolved
delivery intent on the exact session and source turn. A confirmed provider
success resolves it to a durable delivered receipt. A confirmed failure clears
it. Recovery completes a delivered receipt without rerunning tools. If a crash
leaves the provider outcome unknown, recovery resumes with restart-safe tools
so the model can inspect and report the ambiguity without replaying the
external effect.

The delivered reply is also mirrored into the transcript with its source
message ID. Terminal mirrors use a distinct receipt key, so a progress send with
the same provider idempotency key cannot mask the terminal marker. Progress
sends and receipts from older turns cannot complete the current turn. Only
durable channel-ingress claims can restore message-action authority. A resumed
run keeps the original source-delivery mode and source correlation, including
requester identity and any same-channel/thread restriction, so the same receipt
remains authoritative even if another restart happens during recovery. A
message-tool-only delivery policy also survives run admission and model fallback;
private final text never becomes a pending automatic reply. A
message-tool-only turn without reconstructable channel authority is tombstoned
because OpenClaw cannot safely mint message-action authority without the
original channel-ingress claim. The terminal notice directs the user to start a
replacement with `/new` or `/reset`.

A recovered Control UI turn can finish [pinned dashboard widgets](/tools/show-widget)
using the interrupted turn's exact session and recovery claim. A browser connection
does not survive the restart: recovery retains dashboard authoring, while inline
and device presentation still require their normal client capabilities.

Before resuming, the gateway classifies the transcript tail to choose the tool
restriction for the continuation. An aborted turn is the interruption itself,
so it resumes on a best-effort basis whatever abort detail the provider or worker recorded with it:
already-recorded partial text stays in the transcript and the continuation picks up from
the message beneath it, while a tool call left dangling is dropped from the next
provider payload. Provider failures, completed assistant tails, empty transcripts,
and stale pending approvals also continue from the existing transcript. States
with ambiguous side effects normally use restart-safe tools. A session with
effective **Full Access**, including an inherited Full Access default, keeps its
ordinary tools so it can inspect the outcome and finish the task. Recovery does
not replay the interrupted call automatically or treat its missing result as
success. Existing tool restrictions and current permissions still apply.
Recovery prompts identify interrupted, missing, or aborted tool results as unknown
outcomes from the Gateway restart. A follow-up to an interrupted native child
receives the same context so it can verify effects before retrying a tool call.
Pending reply delivery, ambiguous reply-hook outcomes, and explicitly replay-safe
Code Mode reconstruction retain their narrower recovery restrictions.

When the configured tool policy permits automations, a restricted recovery
continuation can inspect their recorded state with `list`, `get`, and `runs`
through the existing tool. Scheduler-wide `status` is unavailable. The continuation
cannot create, update, remove, run, reschedule, or wake work. Existing caller and
current-job visibility restrictions still apply. For a known watcher, use
`get` with its job ID to inspect saved state and `streamStatus`; an empty or
filtered list does not prove that an interrupted action failed or its source
stopped. An outcome that cannot be established from recorded state remains
unknown. Recovery instructions direct the agent to check its current tools and
recorded approval outcomes before promising or attempting further action. A
restart alone does not require the user to repeat the request. When further
action requires a fresh request, the agent should explain that requirement and
continue other permitted work, rather than promise a retry, replacement, or
fallback. These instructions guide model behavior; they do not guarantee the
accuracy of freeform replies. Recovery restrictions do not require a permissions
change or reopen an earlier approval request.

The existing recovery note also includes retained stream approval outcomes tied
to the stored session ID and exact interrupted run. Supported Doctor owner/key
migrations preserve this attribution without reassigning historical approvals.
If an approval was still pending when the Gateway
restarted and was canceled without being consumed, the note records that this
proposal did not save its change. That approval stays closed, but recovery may
continue other authorized work or request fresh approval under the current
configuration. Canceling an update proposal does not stop or remove the existing
watcher. These facts remain in conversation history for
later questions; they do not establish whether other watchers exist or are
running. Missing or unavailable approval records leave the outcome unknown.
The note covers a bounded portion of retained approval history. If more records
remain, it marks unlisted proposal outcomes as unknown.
This uses existing approval retention and requires no data migration.

OpenClaw can also reconstruct interrupted read-only [Code Mode](/tools/code-mode)
work. Code Mode marks these runs as restart-safe and rejects side-effecting
catalog or namespace tool calls before they execute. If a restart lands on
the `wait` control, the new gateway reconstructs the turn from its transcript
and forces the reconstructed execution to remain restart-safe even if the
model omits or clears that flag. The host filters the entire reconstructed
turn to audited read-only core tools and explicitly replay-safe plugin tools,
including when Code Mode is disabled after the restart. Other interrupted
Code Mode work resumes for model reconciliation: Full Access keeps its configured
tool surface unless the current turn has an explicitly replay-safe checkpoint.
Other sessions retain the restart-safe restriction. Recovery uses producer-owned
checkpoint metadata in the transcript, not the rendered tool output: network
wrapping, output truncation, and display hooks cannot change whether a current
checkpoint is replay-safe. Missing or unowned checkpoint facts do not authorize
Code Mode reconstruction. Older text-only checkpoints remain readable during
upgrades. Old process-local runs and approval handles are not revived.

### Subagents

Subagent runs are persisted in the shared SQLite state database, so the
subagent registry survives the process. On boot, children with a recorded Gateway
restart interruption resume as soon as startup restores requester ownership,
without waiting for the periodic registry sweep. The sweep remains a retry backstop.
This includes accepted launches whose child session had not yet recorded its first
lifecycle run when the Gateway stopped. Startup marks that unfinished work as
interrupted under the same session-ownership checks. If it cannot resume through
the existing interruption path, it promptly settles as interrupted and notifies
the requester through normal completion delivery, without waiting for the lost-run
sweep or its cleanup backoff. A different recorded child lifecycle run is never
claimed as an unstarted launch.
The crash-loop breaker pauses this settlement too; the same sweep retries when
the breaker's recovery window ends.
Startup restores completed runs directly from the registry. Any retained delivery
keeps its normal session and ownership checks. Unfinished runs still reconcile
the current child session before resuming.
Human follow-ups in retained child sessions take native custody under the actual
executing run ID and follow-up prompt, including browser chat. Native child
follow-ups sent with `sessions_send` retain registry custody whether the caller
waits for the result or requests an asynchronous completion. An inline result
settles that same completion obligation; it does not send a second parent notice.
The completed original run keeps its own outcome. Human ownership and dashboard nesting do not
turn a child into a main-session replay candidate. The subagent registry owns
continuation in the same child session, using fresh agent admission and the
original requester's current permissions. Automatic recovery uses the same
`sessions.recover` owner as operator recovery, including dashboard/direct children
spawned by a main session. A drain-recorded session interruption remains resumable
even if shutdown ended before the registry recorded the interruption. The existing
registry recovery sweep reconciles that record and admits one continuation;
it does not announce an unfinished child as settled to its parent.
Operator recovery restores the exact
session binding, including for session-scoped operators and collector tasks.
Channel-origin children, including collectors, use the private requester claim saved with the interrupted child;
this claim identifies the original sender and does not grant operator authority.
Dashboard session keys and cron parents do not change this ownership. Internal child turns retain
their admitted requester claim even when they have no outward delivery route.
Its final result follows the normal completion path even when the parent has
already ended its own turn.
If the retained child transcript is empty or missing, recovery records that reason
and settles the interrupted task through its normal parent-notification path.
Restore the transcript before requesting another recovery.
Explicit Stop, cancellation, and replaced child sessions do not resume.
Runs without verifiable session ownership or a restorable requester source settle
through their normal interruption path. When the original child still owns its
interrupted turn but requester authority cannot be restored, recovery also records
a visible interruption in that child’s history. It does not execute work or send
a parent message using the missing authority; a new authenticated message can
continue the retained conversation.
For native children with completion notifications disabled, recovery resumes the
child when possible. If it cannot resume, it sends a private continuation to the
original parent when its saved session identity still matches. Normal successful
completion stays quiet. A reset or cancellation does
not authorize a continuation into a replacement parent session.
If the child session was reset or replaced, recovery settles the old task with
that reason and notifies its original parent without changing the replacement
child session. A quiet child's original parent receives this private outcome too.
Resetting the parent retires that old task's pending notice without attempting
to stop the replacement child session or its descendants.
Cancelled turns can retain a cleanup lease briefly. That lease does not make them
restart candidates; an immediate Gateway restart preserves their terminal outcome.
Finished executions whose final reply is still pending retain their recovery
custody, as do turns interrupted by the restart itself.
Its recovery input lists current unfinished child session and run identities,
including children interrupted by the restart. Older runs superseded by a newer
child run are omitted, as are records from another store, parent session, or
parent lifecycle revision. A reset keeps the session ID but changes its lifecycle
revision, so retained child work from before that reset cannot enter the new
parent's actionable recovery roster. Large lists show the first 32 children and tell the parent
to inspect the remaining children.

The parent must reconcile each unfinished child with its saved history and the
original request before starting additional work. When automatic recovery cannot
continue a child's task, it should prefer a
follow-up in that retained session with `sessions_send`. It first confirms that
the old execution stopped and checks any uncertain tool effects. It can use work
already completed, assign a replacement, or finish the remaining work itself.
Recovery does not automatically replay child commands or duplicate running work.
An interruption alone is not a blocker; the parent continues until the request
is finished or a specific blocker requires user input or unavailable authority.
Interrupted native children retain their session history even when configured
with `cleanup: "delete"`, so the parent can inspect and continue the unfinished
work. Successful runs keep their configured cleanup behavior; normal history
retention still applies. Settled collector groups retain their normal archive
deadline, including groups that could not resume after interruption.

Startup retires superseded requester completion claims through the registry's
cleanup owner before restoring the surviving claim.
Those historical rows do not block current children in the same requester turn
or recovery of other subagents. Saved yield intent is evaluated from the same
current children used for the transfer. Interrupted current children still report
their restart outcome to the parent.
Turns with only superseded children need no requester settlement.

If a parent yielded while waiting for children, its saved batch collects both
completed and interrupted results and wakes the parent once the batch settles.
Yielded turns leave the persisted outcome unset while their continuation still owns unfinished work.
A parent already working on those results resumes through ordinary main-session
recovery. A child result or an `announce:` run identifier does not make unfinished
parent work disposable. Both recovery paths give the parent the interrupted
children's identities and the same reconciliation guidance. Restart interruption
remains in history as an interrupted outcome, rather than a child execution
failure. Genuine execution and delivery failures still require attention.

Saved batch wakes keep their original batch identity and completion-delivery
contracts. Their actionable recovery roster includes only children whose captured
parent ownership still matches. Older or stale records remain ordinary completion
history; they cannot add new instructions to continue those child sessions.
Current reset already revokes its live saved wakes. Recorded outcomes and historical
child metadata are retained.

If a restart interrupts a running requester batch wake, its replay includes the
same restart-interruption guidance as other recovered turns: uncertain tool
outcomes must be verified before repeating actions. The notice belongs to that
turn's input, for both embedded and Codex runtimes. The original accepted settle
content and replay identity stay unchanged; normal batch wakes receive no notice.
The accepted input owns this recovery fact, including when a crash leaves a
committed prompt without a terminal processing receipt. The requester's visible
session status can still describe its earlier yielded turn, so it does not decide
whether the replay needs the notice. Codex may assign the replay a new native turn
identity; the existing hidden transcript input keeps its inter-session provenance.

On upgrade, unfinished runs with the typed Gateway-restart interruption resume
through the same startup path. Already-settled interruption outcomes are not
automatically replayed: the parent may have replaced that work. An operator can
continue a retained interrupted child with `sessions.recover {"key":"<child-session-key>"}`.
This requires the retained session and registry interruption record with current
session-effects ownership; it does not require a main-session restart tombstone.
It cannot recover a deleted session, an expired registry record, or revoked
custody. For those cases, send a fresh request to the retained parent to reconcile
the recorded results and finish or reassign the unfinished work.
A fresh authenticated `sessions.send {"key":"<child-session-key>","message":"<continuation>","idempotencyKey":"<unique-request-id>"}`
can continue the retained child history under the current caller's authority,
including when the old run's registry record or requester source is missing.
Check for an already-running follow-up before sending either request.
Historical failed runs without
that ownership evidence remain failed: their error text alone cannot distinguish
a restart from a genuine failure. Inspect those retained sessions before
continuing them; recovery does not rewrite ambiguous history.

A completed child may still owe its requester a final follow-up. If that
follow-up is waiting for admission or is interrupted by restart, the saved
obligation survives and resumes after startup. Restart admission rejection and
transient preparation failures leave that obligation owed. A new completion wave
waits for interrupted requester work to recover before reserving its mailbox input.
The requester mailbox orders the input under fresh admission; a waiting input has no separate
announcement expiry. An observed terminal delivery outcome settles once. If its
bookkeeping fails, the registry retains that receipt and retries persistence
without resending the result. The outbound durable delivery queue keeps its own
transport retries. Incidental cleanup retains its bounded retry limit.
Settling a yielded turn's wake leaves its unfinished native run and final delivery
intact. Completed cancellation keeps its wake and cleanup bookkeeping in the
native subagent record; it does not require a separate Tasks row.
Recovery reconciles an expired cancellation's retained marker before retrying
its requester wake, preserving the original cleanup record. Live child cancellation
can wake a waiting requester while normal cleanup reconciliation completes.
A delayed cancellation callback cannot reopen completed cleanup.

### Agent-requested restarts

When the agent itself triggers a restart (applying a config change, updating
the gateway, or an explicit restart request), a restart sentinel is written to
SQLite before the process exits. After boot the gateway posts the outcome back
to the originating chat and dispatches any requested one-shot continuation turn
so the agent picks up exactly where it left off, on the same channel and thread.
If interrupted work defers that continuation before execution, it stays in the
durable delivery queue and retries through fresh session admission. A deferred
attempt does not consume the continuation or reuse its retired mailbox input.

For updates, the sentinel carries `stats.runId`, linking the detached updater to
its durable `update_runs` record. The new Gateway records its observed running
version, build, and startup facts there. It preserves a terminal outcome already
written by the updater and waits while a managed handoff is still pending.
Before preparing notices or continuations, it reconciles a newer final sentinel
for that same run and handoff. A pending sentinel keeps its existing bounded
retry window even when the ledger is already terminal; an unrelated replacement
remains untouched. If the helper never publishes its final sentinel, expiry
reports the recorded terminal outcome without changing it. A still-running
Gateway-owned row finishes as failed with `restart-unhealthy`; CLI-owned runs
retain their updater's authority and outcome.
The post-restart notice is rendered from that row using the same report as
`openclaw update status`. Consuming the sentinel does not remove run history.
Sentinels left by older releases retain their existing delivery route.

Any update run with an existing internal origin session, including Control UI
and webchat, appends its report directly to that session's transcript, even when
the caller supplied only `sessionKey` and no `deliveryContext`. A completed
update with no continuation does not wake the model to deliver the report.

The sentinel's typed SQLite columns are authoritative for restart handling.
Its `payload_json` value is a replay/debug shadow only. Runtime reads, writes,
and clears SQLite state without a file fallback. The pre-July
`restart-sentinel.json` format and its `.doctor-importing` claim are retired.
Doctor, update admission, and restart recovery leave these files and any current
SQLite notification unchanged, and require an intermediate upgrade through
`2026.9.7` with `openclaw doctor --fix` before retrying. Supported updaters,
including `2026.6.34` and `2026.9.2`, write native SQLite state and retain their
existing restart delivery and continuation behavior.

## Safety valves and observability

- **Crash-loop breaker:** 3 unclean boots within 5 minutes trip a breaker that
  suppresses auto-start side services on the next boot, so a crashing gateway
  does not amplify itself. A continuously stable safe-mode gateway rechecks the
  breaker after the full unclean-boot window drains and then resumes deferred
  channel auto-start without requiring another gateway restart.

  When the breaker is tripped, the **control plane still starts**, but channel
  plugins (and other auto-started side services) stay down until an operator
  manually overrides the suppression or the full window drains with no unclean
  boots. Recovery preserves channels that an operator manually stopped and any
  separate development-mode suppression. Gateway logs look like:
  `channel autostart suppressed by crash-loop breaker; refusing automatic
  start for <channel>… Start a channel manually with: openclaw gateway call
  channels.start --params '{"channel":"<id>"}'`

  Safe mode also pauses main-session restart recovery. Interrupted entries and
  transcripts stay unchanged: the pause does not charge an attempt, settle a
  turn, send a notice, or tombstone a session. The recovery log names the pause
  and the breaker window end. Once the full window drains, the same healthy
  process automatically re-arms its existing recovery scheduler and resumes the
  interrupted work once, using the original startup cutoff and ownership checks.
  A new unclean boot extends the pause; shutdown or lifecycle replacement cancels
  the pending re-arm. No manual retry or extra Gateway restart is required.

  Operator recovery SOP:

  1. Confirm the gateway process is up (`openclaw gateway status` / LaunchAgent
     or systemd unit still running). A “channel disconnected” symptom often
     means suppressed autostart, not a dead gateway.
  2. Inspect channel state: `openclaw channels status` (add `--probe` when
     useful). Look for stopped / not connected accounts while the gateway
     itself is healthy.
  3. Fix the root cause of the unclean boots (bad config, plugin crash on
     start, missing secrets) before forcing channels back up.
  4. Manually start a channel while suppression is active:

     ```bash
     openclaw gateway call channels.start --params '{"channel":"<id>"}'
     # optional: {"channel":"<id>","accountId":"<account>"}
     ```

     `channels.start` is a **manual** override. It does not disable the
     breaker for other channels.

  5. Or leave the healthy gateway running until the full unclean-boot window
     drains. The same process logs that the restart-loop breaker recovered and
     starts the deferred configured channels.
     If that message does not appear after the window plus one health-monitor
     interval, inspect the gateway logs and run `openclaw doctor` before
     restarting.

  See also [Gateway](/gateway) (safe mode paragraph) for the same control-plane
  vs channel-autostart split.

- **Session preparation:** an interrupted session that is still initializing or
  waiting for workspace setup stays deferred. Recovery rechecks that exact
  startup candidate when its session preparation changes, without charging a
  dispatch attempt while it waits. Shutdown or a new Gateway lifecycle cancels
  the wait; replacing or resetting the session invalidates the old candidate.
  Archived, expired, restart-tombstoned, and provider-review-blocked sessions
  still require their normal operator action.
- **Main-session attempt budget:** three charged automatic dispatch attempts
  per interrupted cycle. Exhaustion tombstones that session until it is
  inspected and replaced.
  Temporary target-resolution failures use the existing bounded startup retries
  without charging a dispatch attempt. Missing owners and mismatched stores
  remain skipped.
- **Metrics:** recovery activity is exported via
  [Prometheus](/gateway/prometheus) as `openclaw_session_recovery_total` and
  `openclaw_session_recovery_age_seconds`.
- **Startup timing:** the `sidecars.subagent-recovery` completion line includes
  `readersMs`, `deliveryMs`, `execMs`, `registryLoadMs`, and `registryActivationMs`
  at the normal info level. Recovery no longer prewarms every agent's readers
  before starting; `readersMs` remains zero. Delivery, exec notification, and
  subagent recovery run independently, and subagent activation preserves ordering
  within each requester session. Independent sessions, including those owned by
  the same agent, continue through a slow database open in another session.
  Their tails remain tracked through shutdown. These elapsed times overlap and
  include dependency loading and waits for workers or database admission. Within `deliveryMs`,
  `deliveryNoticesMs` measures blocked-notice selection and persistence, and
  `retryWaitMs` measures retry backoff; these nested totals are not additional
  phase time. Registry activation includes `registryActivationBindMs`,
  `registryActivationRequestersMs`, `registryActivationResumeMs`, and
  `registryActivationInterruptedMs`. Binding includes
  `registryActivationAuthorityRestoreMs` (original operator authority and
  requester reads) and `registryActivationPublishMs` (recovered owner writes,
  including writer admission). Resume includes `registryActivationReserveMs`
  (controller reservations) and `registryActivationSessionReadMs` (unfinished
  child session reads). `registryActivationYieldMs` totals cooperative event-loop
  waits across binding and resume. Binding and authority restoration sum work
  across concurrent requester groups, so either can exceed activation wall time.
  These are elapsed, overlapping totals, not
  CPU time or a separate measurement of database queue time. Inventory hydration
  precedes activation; `registryLoadMs` measures loading the activation module.
  `registryActivationRuns` counts the captured inventory,
  `registryActivationActiveRuns` counts visited nonterminal runs,
  `registryActivationRecoveredRuns` counts restored Gateway owners, and
  `registryActivationPublishedRuns` counts initial and recovered Gateway bindings.
  Counts and partial timings remain visible on failure, without per-run output.
  Notice selection can wait for database writer admission even
  when an unchanged notice does not need another write. Set
  `OPENCLAW_GATEWAY_STARTUP_TRACE=1` to also log each individual span. The phase
  runs after readiness; its duration does not measure time until the Gateway
  can accept connections.
- **Logs:** recovery decisions are logged under the
  `main-session-restart-recovery` and `agents/subagent-registry`
  subsystems. Every startup pass includes bounded skip counts by reason such as
  `archived`, `live_owner`, `work_start_pending`, `work_start_blocked`, or
  `dispatch_target_unavailable`, even when other sessions started. Each interrupted
  main candidate has a structured decision line with boot/pass, session and source-run identity, outcome
  (`started`, `settled`, `deferred`, or `blocked`), and the next responsible owner.
  Work-start decisions name the specific condition, such as
  `initialization_pending`, `workspace_pending`, `archived`, or `provider_review`.
  Archived sessions are deferred with no next owner, rather than reported as
  blocked work requiring operator action.
- **Reply hooks:** resumed turns run currently loaded `before_agent_reply`
  hooks under the normal user-trigger rules. Automatically delivered replies
  also run the normal `reply_payload_sending` hook before channel delivery,
  with the recovered session, run, account, and conversation context.

## Verify recovery after an update

A healthy Gateway confirms availability, not completion of interrupted work.
Check each previously active session and its child tasks: it should have finished
before shutdown, resumed execution, or reached a visible terminal outcome or
recovery error. Check queued inputs separately for transcript consumption or an
explicit unresolved state.

The main-session recovery log distinguishes execution resumption from the later
`main-session restart recovery terminal` event. A recovered count at startup means
execution resumed. It does not prove that an assistant reply was delivered.
Use the session transcript and recorded delivery outcome to verify completion.

## What is not resumed

- Sessions excluded from main-session recovery because another owner already
  handles them: subagent sessions (resumed by the subagent registry), cron sessions (the
  scheduler owns eligible retries and future occurrences), and ACP-managed sessions (the connected IDE
  or client owns the resume).
- Work that was never admitted: messages arriving during the drain window are
  rejected with an explicit restart error rather than silently queued into a
  dying process.
- Gateway terminal PTYs, including operator- and agent-owned terminals. They
  are process-local and end when the Gateway restarts.
- Standalone embedded turns cannot take over a main session with pending
  restart recovery because they do not share the gateway's lifecycle owner.
  Run the turn through the gateway or reset it there with `/new` or `/reset`.

## Automatic peer results

Saved `sessions_send` inputs retain their original operator scopes during recovery.
Session-only write access can resume updates to authorized sessions without broader
Gateway write access. If current permissions block delivery, the recovery notice
explains that restriction and asks the user to resend; the input remains saved.

Automatic results returned by `sessions_send` use the same communication owner
and pending-input recovery as peer requests. An accepted request also authorizes
its requested result: returning that result does not require new reverse-direction
send or receive permission. New unsolicited sends still follow current access and
communication policy. Result admission checks the exact original source and
destination session incarnations and the accepted request's live authority; a
cancelled or replaced request cannot authorize a result.

A saved result retains its intake instructions and optional reply expectation:
processing it after restart does not require an acknowledgment or send another
reply back to the peer. These saved facts do not recreate sender authority;
recovery uses the retained request owner, and cancelled inputs are not replayed.
Task-owned `subagent_announce` completions retain their separate existing recovery owner. Concurrent history reads during startup retain
the same interrupted disposition, so opening a chat cannot hide a saved update
from the recovery pass. If a restored background event temporarily owns an
interrupted session, startup recovery waits for that owner to release and
rechecks the session. It does not take over live work or replay work that
completed, was stopped, or was replaced in the meantime.
