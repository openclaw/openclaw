---
doc-schema-version: 1
summary: "Graceful Gateway restarts send one ordinary resume input to each running root session; crashes are deliberately lossy"
read_when:
  - You want to know what happens to agent work when the Gateway restarts
  - A restart interrupted an agent, sub-agent, or background process
  - You are checking shutdown or post-update behavior
title: "Restart recovery"
---

A graceful Gateway stop or restart records which root sessions are working, then
aborts that work promptly. At the next startup, each marked session gets one
ordinary system input asking the agent to inspect current state and continue.
The transcript remains the agent's context; the Gateway does not reconstruct or
replay the old execution.

A crash or `SIGKILL` does not write these markers. Nothing resumes automatically
from that process. Open the conversation and send a message to continue. This is
an accepted loss window: files, external actions, and tool effects may already
have changed, so check them before repeating work.

## What survives a restart

| State                                                | Behavior                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Conversations and transcripts                        | Remain in the per-agent SQLite database                                         |
| Running root session at graceful shutdown            | Receives one resume input at the next startup                                   |
| Accepted user input captured in that shutdown marker | Runs after the resume input, in FIFO order, with its sender's current authority |
| Running sub-agent                                    | Stops quietly; its root requester receives the resume input                     |
| Background process                                   | Ends with the old process; its root session receives the resume input           |
| Already-produced outbound messages and media         | Keep the existing delivery queue and delivery reconciliation                    |
| Scheduled jobs                                       | Keep cron's own scheduling, catch-up, and interruption policy                   |
| ACP or external-harness session                      | Keeps its harness owner's restart policy                                        |
| Update outcome                                       | Remains a passive report in the originating conversation                        |
| Gateway terminal PTY                                 | Ends with the old process                                                       |

A session counts as running when its own agent loop is active, a descendant
sub-agent is running, or it owns a running background process. The Gateway reads
these facts from their live in-memory owners during shutdown. A child contributes
to its top-level requester; the child does not receive an independent resume input.
Idle and finished sessions are not marked. Cron occurrence sessions and
ACP/external-harness sessions are excluded.

The marker is a small private field on the existing session entry. It records the
IDs of accepted user inputs still queued behind that session at shutdown. The
Gateway writes one marker per running root session, batched by session store,
before aborting work. It uses the existing session-entry JSON in SQLite and needs
no schema migration.
There are no restart checkpoints written per turn or tool call, startup orphan
scans, or crash-time execution reconstruction.

<a id="graceful-restarts-drain-first" />

## Graceful shutdown

Once a stop or restart is committed, the Gateway fences new admission, snapshots
running sessions, writes their markers, and aborts active runs. It waits only a
short bounded time for in-flight persistence and gives other resource cleanup a
bounded grace. A long model stream, tool call, or background process does not get
a full run-completion drain before shutdown.

A plain stop (`SIGTERM` or `SIGINT`) arriving during an in-process restart makes
the Gateway finish its bounded shutdown and exit instead of starting again.
Managed update handoffs keep their own stop handling.

An external stop or restart logs bounded-grace leftovers, such as a service-child
cleanup deadline, lifetime sidecar, or retained plugin runtime, and returns with
status `0` unless required persistence failed. A runtime that still owns resources
is never reused for an in-process restart. Node exits naturally after owned handles
close; the native shutdown watchdog kills the process if leaked handles keep it
alive past the deadline. That signal exit is accepted, and the supervisor starts
a fresh Gateway.

Reversible suspension and host freeze preparation keep their own semantics. A
suspension does not mark sessions or abort them. Preparation with `drain: true`
can become ready once persistence is clear; the committed stop or restart performs
the snapshot and abort.

Requests the Gateway did not accept before admission closed receive the ordinary
retryable restart error. Clients retain their submission IDs and use normal
reconnect handling. A disconnected RPC may already have performed its work;
clients reconcile the existing receipt rather than replaying arbitrary RPCs.

### Maintenance custody observations

Gateway `status` reports its process-owned `shutdownBudget`, with `activeWork`
counts and a separate `writeCustody` array. Suspension preparation and status
responses can include `writeCustody` entries with `phase` and `count`, covering
migration, backup, coordinator writes, session lifecycle mutation, and terminal
persistence. Ordinary root requests and cron runs do not by themselves imply write
custody. Counts can overlap.

Older Gateways can omit this optional distinction. Their running code keeps its
old shutdown behavior until restarted; installing new files cannot shorten an
already-running Gateway's drain.

### Systemd stop deadlines

The Gateway inspects the running unit's effective `TimeoutStopUSec`, including
drop-ins, and caps cleanup to the supervisor's remaining stop budget. Inspection
and startup waits consume that same deadline. OpenClaw-managed units currently
request `TimeoutStopSec=330`; this is an outer safety allowance, not a request to
wait for agent work to finish.

Use `KillMode=mixed` so systemd's initial stop signal reaches the Gateway rather
than every child runtime. Systemd can still terminate remaining children after
the Gateway exits or its deadline expires. `openclaw doctor --fix` and updates
refresh outdated generated unit policy; operator-owned drop-ins remain the
operator's responsibility. Inspect them with:

```bash
systemctl --user cat openclaw-gateway.service
systemctl --user show openclaw-gateway.service -p TimeoutStopUSec
```

Use the system manager without `--user` for a system service. If inspection fails,
the Gateway logs a warning and uses its conservative fallback budget. A failed
shutdown reread does not grant a longer timeout. See [Linux services](/platforms/linux).

### Launchd stop deadlines

The macOS Gateway reads the loaded job's effective `exit timeout` with
`launchctl print`, binding it to the Gateway or its launcher PID. The loaded job,
not the plist on disk, determines the deadline. Editing a plist or using
`launchctl kickstart -k` does not reload it; service replacement does.

Generated LaunchAgents request `ExitTimeOut=330`. Doctor can migrate the retired
20-second generated template after backing it up, but preserves customized values.
A launcher can impose a shorter child-reap deadline. Inspect the loaded job rather
than assuming the plist value is effective. See [macOS Gateway](/platforms/macos).

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
through `gateway.suspend.*` is reversible: it neither writes restart markers nor
aborts running sessions. Work continues under the suspension owner after resume.

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

## Automatic resume

Startup clears each marker and admits exactly one new input through the normal
session-event path:

> The Gateway restarted while you were working. Resume your work: check the current state of anything that was in progress (files, processes, subagents, external actions) before repeating it, then continue.

If the session had running background exec processes, that same input also says:

> Background exec processes were stopped; rerun them if still needed.

This is a new input, not a replay of the original user prompt or unfinished tool
call. Later model requests can contain the text as conversation history. The
agent checks the transcript and current state before continuing; effects are not
guaranteed exactly once.

For a session with a human owner, the input uses that recorded principal's current
role, scopes, and session access, narrowed by the session's current permission mode
and tool policy. When no owner is set, the human creator is used. A removed
principal, lost access, or archived/deleted session is skipped with a log entry.
The Gateway never substitutes an administrator or restores a saved operator grant.
Sessions with no human principal use ordinary system-event authority; if it lacks
a needed capability, the agent must ask for an authorized input.

WebChat uses the same session and transcript. Channel sessions use their current
delivery route so normal replies return to the conversation. The resume input
inherits no old browser connection, device capability, approval, or requester
authority snapshot.

Only accepted user messages whose IDs were captured in the graceful-shutdown
marker follow the resume input, in FIFO order. Older queued rows left by a crash
remain inert, even if the session is marked during a later shutdown. Each retained
message runs as its recorded sender under that sender's current authority. If the
sender is revoked or cannot be resolved to a current principal, the message becomes
an ordinary failed send that the sender can resend. A channel identity without a
profile does not authorize queued execution after restart.

New messages arriving during a resumed run use ordinary steering and queue rules.
There is no recovery-predecessor wait or special recovery admission lane. Explicit
Stop, cancellation, archive, and reset keep their normal meanings.

### Subagents

Graceful shutdown marks the root requester of a running child, then cancels the
child through the ordinary abort path. The child settles terminally without a
shutdown completion announcement or a "subagent failed" notice to its parent.
Children are not adopted or independently resumed at startup.

The parent's single resume input covers reconciliation of its children. It can
inspect their transcripts and results with the existing sub-agent tools, then
send a new instruction or spawn replacements after checking what already happened.
See [Sub-agent operations](/tools/subagents/operations).

### Agent-requested restarts

The restart sentinel keeps the update or restart outcome and its originating
route. It can append the passive outcome report or deliver already-produced bytes;
it does not launch another model turn or replay an update continuation. If the
requesting session was running at graceful shutdown, the generic marker sends its
one resume input.

Update sentinels retain their `stats.runId` link to `update_runs`. The new Gateway
records observed version/build and startup facts without replacing a terminal
outcome already written by the updater. The originating session keeps the report;
consuming a sentinel does not remove update history. See
[Update reports](/cli/update#run-history-and-reports).

The sentinel's SQLite columns remain authoritative. Retired `restart-sentinel.json`
and `.doctor-importing` files are not runtime inputs. Installations requiring that
old import must upgrade through `2026.9.7` and run `openclaw doctor --fix` first.
Legacy delivery-queue rows requesting inference remain inert; they do not grant
permission to run a model.

## Safety valves and observability

The crash-loop breaker still suppresses automatic side-service startup after
three unclean boots within five minutes. The control plane remains available for
inspection. A stable process rechecks after the full window drains and starts
eligible deferred channels; manually stopped channels remain stopped.

If the Gateway is reachable but channels stay down, inspect
`openclaw gateway status --deep` and `openclaw channels status --probe`, fix the
startup failure, and use `openclaw doctor` as needed. An authorized operator can
manually override suppression for one channel:

```bash
openclaw gateway call channels.start --params '{"channel":"<id>"}'
```

This override does not disable the breaker for other channels. Crash-loop handling
does not reconstruct work from an unclean shutdown.

Startup migration warnings remain visible in status and Doctor. Unsafe required
state still prevents startup. Run `openclaw doctor --fix` against the same state
and configuration before restarting when the diagnostic asks for repair.

Marker persistence, skipped authority, and bounded shutdown leftovers are reported
in logs. A resume admission proves only that the new input was accepted; use the
session transcript and actual delivery outcome to check whether work finished.

Old restart claims, authority snapshots, interrupted pending-input rows, and queued
inference records may remain in existing databases. They are ignored rather than
reconstructed or deleted. Their text stays preserved. Legacy interrupted and
ownerless queued inputs left by a crash do not add pending counts, notices, or
history pins. Normal retention applies to data that was pinned only by those
retired recovery records.

## Verify recovery after an update

Confirm the Gateway is ready, then inspect each previously running root session.
It should have one resume input and the resulting work or an actionable ordinary
error. Idle sessions should have no new model turn. Check queued user messages for
normal transcript consumption or a failed-send outcome. A healthy process alone
does not prove that a reply reached its channel.

## What is not resumed

- Work from a crash or `SIGKILL` without a graceful-shutdown marker.
- Idle or finished sessions.
- Sub-agent children independently of their root requester.
- Cron occurrences and ACP/external-harness work, which keep their own owners.
- Deleted or archived sessions, and human-owned sessions whose current principal
  cannot be admitted.
- Gateway terminal PTYs and background OS processes.
- Legacy inference queue entries or old execution-recovery records.

After a lossy stop, the stored conversation remains available. Send a new message
to continue and inspect uncertain effects before repeating them.

## Automatic peer results

Ordinary live `sessions_send` communication and its current authorization remain
unchanged. Restart does not restore a peer sender, replay a requester-settle input,
or launch a new model turn from a saved completion. Already-produced outbound
messages and media retain their delivery owner. A running root session's resume
input is responsible for inspecting pending child or peer work.
