---
summary: "`openclaw update status` plus the durable run ledger, reports, and artifacts every update writes"
read_when:
  - You want to check whether an update is available before applying one
  - You are inspecting a past update run, its reports, or its artifacts
title: "Update status and run history"
sidebarTitle: "Status and history"
---

Availability checks and the durable record every update leaves behind. Part of the [`openclaw update`](/cli/update) reference.

## `update status`

Show the active update channel, git tag/branch/SHA (source checkouts only),
update availability, and the active or most recent update report.
While an update is active, the table shows its phase instead of advertising another
update, and the final line points to `openclaw update status`. JSON still includes
registry/Git `availability` separately from `activeRun`.

Git availability checks, including the Gateway's background check after startup,
refresh only the selected upstream. They do not import other remote branches or
tags, prune existing refs, or change shallow-history boundaries. A fresh detached
Dev checkout can discover its configured `main` upstream without first fetching
the remote's full ref inventory. Local upstreams need no fetch; an unknown upstream
stays unknown. The selected upstream's own missing history may still be downloaded.
Ahead/behind counts remain unavailable when shallow history has no merge base.

For a clean source checkout configured with `update.channel: "stable"` or `"beta"`, `update status --json` can include `update.git.preferredTarget` with `channel`, `tag`, and the exact commit `sha`.
This uses the updater's release selector and fetches into a temporary private Git repository, preserving the installed refs and checkout.
The selected tag must still resolve to that commit at the release remote; retained local-only tags do not count as fresh targets.

An absent field means unknown.
Default/dev targets, explicit refs, unsupported channels, dirty checkouts, and unsuccessful inspections do not produce this fact.
It describes the preferred selection for the observed configured channel, not candidate build success, downgrade approval, service readiness, or safe state recovery.
An explicit update invocation can select a different target or install method.
Older installed status commands cannot acquire this observation from candidate code.

If an update hands work to a background helper, the command has not finished the
update. Follow its final `openclaw update status` command to check progress and the
outcome. `openclaw gateway status --deep` checks Gateway health, not update progress.

Status also shows unfinished plugin data/settings upgrades and their repair commands,
including when an older updater did not record those warnings in its run history.
During an active update, let that update finish before following plugin repair
advice. Existing plugin data and settings are kept until the upgrade completes.
JSON exposes these messages as `migrationWarnings`; they clear when the plugin migration
completes. If migration state cannot be read, `migrationWarningsError` reports
that failure while availability and run history remain visible.

When the Gateway is reachable, status also reads its recorded channel warnings
without probing channel services. JSON exposes these as `channelIssues`. This
includes blocked channel startup after a local plugin requests trusted runtime
state, with the source and supported installation remedy. An unavailable Gateway
does not prevent availability or run-history output.

For a local Gateway, status also shows when its last shutdown recorded an
installation replacement, even after the successor starts. JSON exposes the
recorded reason and completion time as `lastGatewayInstallationReplacement`.
This is historical information, not a current health verdict or an update run;
a manual package-manager replacement does not create updater history.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

| Flag                  | Default | Description                         |
| --------------------- | ------- | ----------------------------------- |
| `--json`              | `false` | Print machine-readable status JSON. |
| `--timeout <seconds>` | `300`   | Timeout for checks.                 |

Explicit timeouts replace the default. Local installation discovery keeps its
own inspection budget.

For extended-stable package installs, status performs the same public selector
and exact-package verification as foreground update. It can report
`ahead of extended-stable` when the installed version is newer. JSON failures
include `registry.reason` (`selector_missing`, `selector_query_failed`,
`exact_package_mismatch`, or `unsupported_git_channel`).

## Run history and reports

Every admitted update has a durable `runId`, including updates requested from
chat, the Control UI, the CLI, and automatic update campaigns. Dry-run previews
on profiles with an existing runtime database and updates refused after admission
keep a skipped or failed record with their reason. A fresh-profile dry-run leaves
the database absent and records no run. CLI invocations rejected before admission
leave state untouched. The same ID follows
the detached updater and the restarted Gateway, so reconnecting does not lose
the outcome. Post-core finalization children report back to their parent without
creating a separate update run, including when an older updater cannot forward
a run ID.

On an existing profile, update history admission waits for a database writer using
the update's step timeout (30 minutes by default, or `--timeout`). If that wait
expires, the command exits successfully with a deferred `update-ledger-busy`
outcome and retry guidance. It does not claim an update completed or create a run;
previous history remains visible. A dry-run reports the incomplete preview in
`notes`. Repair uses its existing preflight budget for the same admission.
Status and background history work retain their shorter wait budget.
Hidden post-core finalization returns a nonzero exit with the same deferred
reason when admission is exhausted. Its Gateway parent records a skipped outcome
and leaves restart pending until a later update completes plugin convergence.
Public `update`, `--dry-run`, and `update repair` keep the successful deferral exit.
This behavior requires the updated CLI: a previously installed updater cannot
use candidate code before its own history admission completes.

Triage preserves the original update report. Any update launched during repair
gets a separate `runId`.

Unexpected automatic-update campaign failures retain the error code, when present,
and a redacted diagnostic in the run history as well as the Gateway log. Status
and the bounded run report show the cause after the campaign clears. This requires
the updated Gateway; older runs cannot recover a cause that was never recorded.

An admitted `openclaw update --json` includes `runId` and the `run` record. `openclaw update status --json`
includes `activeRun` when a run is active and `lastRun` when history exists.
An automatic-update campaign stops showing as applying when its own admitted run
finishes, including when a managed handoff fails before restarting the Gateway.
The Gateway reconciles the exact campaign run, so newer unrelated runs do not
keep a finished campaign busy or clear a different active campaign.

Retained dry-run previews remain available through history queries but do not
replace `lastRun`, so a preview cannot hide the last real update failure.
If history cannot be read or classified, status still shows update availability
and runtime findings. Human output explains that run status is unavailable;
JSON includes `runStatusError` and omits the run fields. This does not mean
there are no active or past runs, and status does not repair unreadable history.

Status can reconcile an untouched, identityless legacy admission after more than
24 hours if it remains at its initial `requested/in_progress` step and has no
retained recovery descriptor. The row stays in history as `failed` with reason
`legacy-driver-expired`. Status shows retry guidance when that row is the current
run. When another run is current, status keeps a historical notice without retry
instructions, including after a later successful update. Other history remains read-only.

When the active row has been inactive for more than 30 minutes and its recorded
driver is verifiably dead, status also reports `abandonedRun` with its `runId`
and reconciliation `rule`. For these rows, status remains read-only: the stored
row stays in `activeRun` until the Gateway or explicit repair commits the outcome.
Identityless rows outside the legacy-expiry shape are not reconciled automatically.
For those stale identityless rows, JSON includes
`staleRun` with `runId` and `guidance`; human status and Doctor preflight report
"no activity since &lt;time&gt;; if no update is running, run `openclaw update repair`
or start a new `openclaw update`".

An explicit new `openclaw update` (including `--dry-run`) supersedes the old row
only when it is the sole active run, has no recorded driver identity, and has
had no activity for more than 30 minutes. Admission atomically finishes that
row as `failed` with reason `superseded` and a retained `reconcile:superseded`
step, then creates the new run. Recent rows and rows with recorded identities
are preserved. Inherited update continuations and automatic campaigns do not
supersede legacy history. Configuration writes remain suspended until the
active row is reconciled.

OpenClaw 2026.9.2 can admit a new CLI update while an older row remains running;
the stale row does not block updater admission. Upgrade normally, then run
`openclaw update repair` from the updated installation if status still shows the
old run. See [Updating](/install/updating#stale-update-history).

Human output, chat completion notices, the Control UI update view, and the
`openclaw status` update line use the same report, including on success. The report shows recorded facts; an absent verification fact
means that check has not been observed.

An unsuccessful identity check is reported as a version or build mismatch only
when the saved observed and expected values disagree. Missing identity evidence
is reported as unavailable, including old runs whose updater saved only
`versionMatch: false`.
The Control UI's version badge shows **Not verified** for unavailable identity
evidence and **Failed** for an observed version or build mismatch. This does not
change the recorded update outcome.

For failed runs, human status, completion notices, and reviewed failure reports
also try a read-only health request to the recorded Gateway port. A response
supersedes historical claims that the Gateway is stopped; it does not change the
failed update outcome or verify rollback safety. Saved recovery advice is labeled
historical, preserving config and migration constraints. If current health cannot
be read, the report says so. JSON run records remain the original historical facts.

Failed steps include bounded `failureFacts` when the updater observed a specific
check, Doctor finding, package-manager error, service inspection reason, or plugin
failure. Each fact names the check and reason code, with an optional affected
config key, plugin ID, and one diagnostic line of at most 200 characters. These
facts survive the run ledger and appear in the local summary and the reviewed
GitHub failure report. Secrets and private paths are redacted before recording;
public reports include recognized error causes instead of arbitrary command or
user text, and show config key families instead of operator-defined names. Only
catalog-confirmed public check and plugin IDs are included; unknown IDs and codes
remain complete locally and are redacted publicly. Older runs cannot recover facts that their updater did not record. Existing history
and report size limits still apply.

npm failure records keep the first five sanitized error lines in order. Lines over
200 UTF-8 bytes retain a prefix followed by a space and an explicit `…[truncated]`
marker within that budget. A failed package baseline scan records
`baseline-scan-failed` with the scan's original cause, including when its identity
fallback also fails. A timeout with a successful fallback remains a warning.

When a managed-service handoff cannot start or transfer ownership, the Gateway
records the refusal on the failed `requested` step. Status includes the recorded
diagnostic after the reason code; chat and failure reports use the same facts.
Public reports preserve recognized handoff diagnostics, including the instruction
to run `openclaw doctor` when the installed updater cannot be found. This applies
once the Gateway runs the updated code; older reports cannot recover missing facts.

Failed finalization steps record their reason code before failure reporting starts.
Standalone finalization also records the package or Git install kind. For package
installs it records that package rollback is unnecessary because finalization does
not replace the core package; this does not claim that Doctor left config or state
unchanged, or that Gateway health was verified. Failure reports include recognized
error codes and causes from the failing step's retained diagnostics, including beside
a process exit code (for example, `exit 1 (EACCES; Permission denied)`). Arbitrary
log text stays private; steps without a recognized diagnostic show only their exit.

Recoverable maintenance failures appear as recorded warnings even when the update
succeeds. Each warning names the skipped work, the cause, and a repair command.
Doctor also shows warnings from the latest run as historical observations: a later
repair may already have resolved them. The existing report and history size limits
still apply.

A foreground updater publishes its final result after required finalization work
and its local executor have settled. A late ownership or release failure returns
an error instead of publishing an earlier success. Existing terminal history is
not overwritten.

Unexpected executor admission, settlement, or report publication failures also
record the last reached phase, the redacted error, and whether rollback was needed
or attempted before offering an interactive failure report. If ownership is lost
or pending recovery prevents a safe history write, the command reports recovery
pending and preserves the existing history for its owning updater instead of
starting interactive triage.

Activation has an enclosing deadline derived from the update's existing phase
budget. If it expires, the updater cancels owned work and waits within that budget
for its child processes to settle, then records `update-activation-timeout` as a
failed outcome. A child that has not stopped retains its ownership and recovery
state. Inspect `openclaw update status` and `openclaw doctor`, and wait for the
owning updater and its children to stop before running `openclaw update repair`.
The timeout does not authorize rollback or removal of retained update state.
If migration or pending recovery prevents a safe history write, the updater
reports the timeout and preserves that state for its owning runtime to reconcile.

Successful installation verification does not imply that obsolete package backups
were deleted. If the package owner confirms that only obsolete-backup cleanup is
pending, JSON, history, and human reports include a warning with the retained path
and follow-up guidance. Unverified recovery, unreadable backup state, and unknown
completion failures remain errors. Inspect retained paths before manually removing
obsolete backups; unresolved recovery material is not eligible for this cleanup.

Gateway clients with `operator.admin` can inspect history:

```bash
openclaw gateway call update.runs.list --params '{"limit":10}'
openclaw gateway call update.runs.get --params '{"runId":"<run-id>"}'
```

`update.runs.list` returns `{ runs }`; `limit` defaults to 20 and is capped at 100. `update.runs.get` returns `{ run }`, with `run: null` when the ID is unknown. `update.status` retains its existing
fields and adds optional `activeRun` and `lastRun` records. While a run is active,
the Gateway broadcasts `update.run.changed` with `runId`, `phase`, `status`, and
`updatedAtMs`. Reconnect and read the row to recover changes missed during restart.

The Gateway's `update.status` reports current automatic-update policy and any live
campaign independently of checkout discovery. Installation details can arrive
later; reading status does not start scheduling or clear an active campaign. If
the update channel cannot be resolved, `schedule` remains absent rather than
claiming the scheduler is idle.

When a history request needs a read-only snapshot, the Gateway prepares it
asynchronously so other requests can continue. The snapshot preserves the source
database and its sidecar files. The Gateway's `update.status` reads its two run
records through the already-open database when available, avoiding full-database
copies on each poll. Cold status reads prepare one private snapshot. When
diagnostics are enabled, status requests lasting at least one second log phase
durations for sentinel refresh, checkout refresh, install identity, reconciliation,
history, and response.

Native service-stop observations do not advance the update's recorded phase.
If the Control UI cannot read fresh progress, it shows the read error alongside
the last recorded run; use **Check status** to retry without starting another update.

Phases are `requested`, `staging`, `validating`, `activating`, `restarting`,
`verifying`, and `finished`. Status is `running`, `succeeded`, `failed`,
`rolled-back`, or `skipped`. Older updater records can also contain `repairing`
and inference-repair attempts. Current inference repair belongs to post-failure
triage and does not rewrite the update outcome. Phase timings, repair attempts, and
verification facts are included only when observed. Chat reports are limited to 1,500 characters;
`update.runs.get` preserves the bounded record for detailed inspection.

If a stable Gateway is still starting when the readiness allowance ends, the run
finishes `skipped` with reason `gateway-readiness-unverified`. This means the
installation completed, readiness was not confirmed, and recovery backups were
retained. `finishedAtMs` records when observation ended; `confirmedAtMs` remains
`null`. The warning log preserves the elapsed allowance and last service/HTTP
observation. No background readiness continuation is promised. Check current
health with `openclaw gateway status --deep`; later health does not rewrite this
historical outcome. A Gateway that becomes ready within the allowance records
`succeeded` and `confirmedAtMs` when readiness is reached.

Standalone finalization and repair record the installed target version before
Doctor runs. Failed Doctor steps retain the observed child exit code alongside
the bounded, redacted failure reason; a terminated child can have a `null` exit
code. Status and failure reports use these same recorded facts. The installed
version is not proof of the version currently serving requests. Optional Doctor
diagnostic failures remain warnings, while refused config writes and incomplete
required migrations remain errors. Historical runs cannot recover facts that
their updater never recorded.

Current updaters record their process identities and refresh the ledger
every 30 seconds during long build, install, and finalization phases. Those
writes pause whenever a Doctor child is repairing state: finalization pauses them
for repair Doctor, including the post-plugin Doctor, and installation pauses them
for the activation Doctor step. These phases record their start and completion;
the recorded driver identity protects the running update while its last-activity
timestamp stays unchanged.
The Gateway checks for
abandoned runs at startup and while following active updates. When verified
completion cannot be recovered, more than 30 minutes without step or heartbeat
activity and verifiably dead recorded drivers allow the Gateway to finish the run as `failed` with reason `abandoned` and a
`reconcile:abandoned` step naming the rule. A live, unreadable, or foreign-host
driver prevents reconciliation. Each helper or finalization child records its
own identity and retains earlier drivers, because detached children can outlive
their parent. If process identity recording is unavailable, the update continues
with one warning and the run requires explicit recovery. Known parent identities
remain protected, and automatic reconciliation stays disabled for that run.
Heartbeat write errors warn once per driver run and do not interrupt a running
build, install, or finalization phase.

An updated candidate records its installed version and build identity after
post-core work finishes, before handing completion back to the installed updater.
If the updater exits during restart verification, the Gateway or Doctor can
finish the run as `succeeded` after fresh checks confirm that the installed and
serving builds match that recorded target and the Gateway is ready. This also
allows a matching `abandoned` outcome to be corrected, with the reconciliation
recorded in history. Live or unobservable drivers, retained recovery work, and
recorded repair, failure, or rollback evidence remain protected.

Interrupted completion checks share one 50.5-second deadline across setup,
service and port inspection, health settlement, and final identity checks. The
report and warning log record settlement, timeout with elapsed time and phase,
or an unverified observation. A timeout is a warning and leaves the run eligible
for later reconciliation; repeated diagnostics do not renew its abandonment timer.
Runs without a recorded completed managed-service restart skip the probe and
record that skip. No fresh service-status read can permanently exclude a managed run.
If native probe cleanup is still pending at the deadline, completion remains
unknown. Later cleanup confirmation preserves the original timeout; cleanup
failure records both facts and names the failure in the report and warning log.
Unknown cleanup never records success. Inspect `openclaw update status` before
recovery; repeated diagnostics do not extend the abandonment timer.

Older interrupted runs may lack the target build identity needed for that check.
Doctor names the abandoned run and explains why it cannot settle it; a matching
version number alone is insufficient. Inspect the run's recorded steps and use
[`openclaw update repair`](/cli/update/repair-and-recovery) when recovery is needed.

Historical identityless rows outside the legacy-expiry shape require explicit
`update repair` or a new operator-started `openclaw update`.
An old `requested` row alone does not prove that its updater exited: the 2026.9.2
updater can still be waiting on package-manager or registry preflight before it
records its first staging step. Stop an unrecorded old updater before explicitly
recovering its stale row. See [Database schemas](/reference/database-schemas#update-run-ledger).

The run records `downtimeMs` from the service stop request until a Gateway is
verified running. Staging, candidate validation, and pre-activation repair are excluded. Verification
records include service PID/port, version/build identity, settled health,
plugin activation errors, channel readiness, and `/readyz`.

With transactional updaters from 2026.9.3 onward, a fresh process from the
candidate completes verification after a live database migration and writes the
final outcome to the same run. It carries forward the activation steps; a schema
upgrade does not create a separate report or let the old updater reopen the
newer database.

The 2026.9.2 updater keeps its own completion path. For shared-state migrations,
the candidate applies schema content but delays version publication until every
affected terminal run is at least five minutes old, or each still-running row
has been unchanged for more than 30 minutes. Doctor reports the deferral; the
new Gateway already uses the migrated content and publishes the version after
the deadline. Pending agent-database migrations, missing state metadata, and
failed content migrations still produce `update-schema-bump-unfenced` with
[manual update commands](/install/updating#updating-from-2026.9.2-across-a-schema-bump).
See [Database schemas](/reference/database-schemas#schema-bumps-and-older-updaters)
for exact publication rules and the remaining risk to a stalled old CLI's final
report.
