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

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

| Flag                  | Default | Description                         |
| --------------------- | ------- | ----------------------------------- |
| `--json`              | `false` | Print machine-readable status JSON. |
| `--timeout <seconds>` | `3`     | Timeout for checks.                 |

For extended-stable package installs, status performs the same public selector
and exact-package verification as foreground update. It can report
`ahead of extended-stable` when the installed version is newer. JSON failures
include `registry.reason` (`selector_missing`, `selector_query_failed`,
`exact_package_mismatch`, or `unsupported_git_channel`).

## Run history and reports

Every admitted update has a durable `runId`, including updates requested from
chat, the Control UI, the CLI, and automatic update campaigns. Dry-run previews
and updates refused after admission keep a skipped or failed record with their
reason. CLI invocations rejected before admission leave state untouched. The same ID follows
the detached updater and the restarted Gateway, so reconnecting does not lose
the outcome. Post-core finalization children report back to their parent without
creating a separate update run, including when an older updater cannot forward
a run ID.

Triage preserves the original update report. Any update launched during repair
gets a separate `runId`.

`openclaw update --json` includes `runId` and the `run` record. `openclaw update status --json`
includes `activeRun` when a run is active and `lastRun` when history exists.
When the active row has been inactive for more than 30 minutes and its recorded
driver is verifiably dead, status also reports `abandonedRun` with its `runId`
and reconciliation `rule`. Status remains read-only: the stored row stays in
`activeRun` until the Gateway or explicit repair commits the outcome.
Identityless rows are never reconciled automatically, even when their only
step is `requested/in_progress`. For stale identityless rows, JSON includes
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

Gateway clients with `operator.admin` can inspect history:

```bash
openclaw gateway call update.runs.list --params '{"limit":10}'
openclaw gateway call update.runs.get --params '{"runId":"<run-id>"}'
```

`update.runs.list` returns `{ runs }`; `limit` defaults to 20 and is capped at 100. `update.runs.get` returns `{ run }`, with `run: null` when the ID is unknown. `update.status` retains its existing
fields and adds optional `activeRun` and `lastRun` records. While a run is active,
the Gateway broadcasts `update.run.changed` with `runId`, `phase`, `status`, and
`updatedAtMs`. Reconnect and read the row to recover changes missed during restart.

Native service-stop observations do not advance the update's recorded phase.
If the Control UI cannot read fresh progress, it shows the read error alongside
the last recorded run; use **Check status** to retry without starting another update.

Phases are `requested`, `staging`, `validating`, optional `repairing`, `activating`,
`restarting`, `verifying`, and `finished`. Status is `running`, `succeeded`,
`failed`, `rolled-back`, or `skipped`. Repair may also follow `verifying` when
automatic rollback cannot complete. Phase timings, repair attempts, and
verification facts are included only when observed. Chat reports are limited to 1,500 characters;
`update.runs.get` preserves the bounded record for detailed inspection.

Current updaters record their process identities and refresh the ledger
every 30 seconds during long build, install, and finalization phases. The Gateway checks for
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

Historical rows without a driver identity require explicit `update repair` or
a new operator-started `openclaw update`.
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
