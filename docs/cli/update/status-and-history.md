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

Status also shows current pending plugin migrations and their repair commands,
including when an older updater did not record those warnings in its run history.
JSON exposes them as `migrationWarnings`; they clear when the plugin migration
completes. If migration state cannot be read, `migrationWarningsError` reports
that failure while availability and run history remain visible.

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

An admitted `openclaw update --json` includes `runId` and the `run` record. `openclaw update status --json`
includes `activeRun` when a run is active and `lastRun` when history exists.
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

When a history request needs a read-only snapshot, the Gateway prepares it
asynchronously so other requests can continue. The snapshot preserves the source
database and its sidecar files.

Native service-stop observations do not advance the update's recorded phase.
If the Control UI cannot read fresh progress, it shows the read error alongside
the last recorded run; use **Check status** to retry without starting another update.

Phases are `requested`, `staging`, `validating`, optional `repairing`, `activating`,
`restarting`, `verifying`, and `finished`. Status is `running`, `succeeded`,
`failed`, `rolled-back`, or `skipped`. Repair may also follow `verifying` when
automatic rollback cannot complete. Phase timings, repair attempts, and
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
abandoned runs at startup and while following active updates. After more than
30 minutes without step or heartbeat activity, verifiably dead recorded drivers
allow the Gateway to finish the run as `failed` with reason `abandoned` and a
`reconcile:abandoned` step naming the rule. A live, unreadable, or foreign-host
driver prevents reconciliation. Each helper or finalization child records its
own identity and retains earlier drivers, because detached children can outlive
their parent. If process identity recording is unavailable, the update continues
with one warning and the run requires explicit recovery. Known parent identities
remain protected, and automatic reconciliation stays disabled for that run.
Heartbeat write errors warn once per driver run and do not interrupt a running
build, install, or finalization phase.

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
