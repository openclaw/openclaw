---
summary: "Doctor postures, example invocations, and the full option table"
title: "Run doctor"
read_when:
  - You want to run `openclaw doctor` and pick the right posture
  - You need the meaning of a doctor flag or a flag combination rule
---

This page covers how to invoke `openclaw doctor`: the supported postures, ready-to-run
examples, and every option the command accepts.

If a plugin fails to load during Doctor, the report includes an error finding
with the plugin ID, source path, and error. `ENOSPC` failures name the disk-space
cause. Standalone `doctor --non-interactive` exits `1` for these failures and
reports that Doctor finished with plugin load errors. When an updater invokes
Doctor, the same failures remain recorded warnings so an otherwise safe update
can continue; rerun Doctor after resolving the reported cause.

The CLI drains its shared-state database workers before exiting. Scripted callers
must still check the process exit status: `Doctor complete.` records completion
of the checks, but a subsequent crash remains a failed candidate-Doctor step
during an update.

Doctor checks every configured agent. Plugin metadata retained between workspace
checks is bounded, so adding agents does not retain a full plugin inventory per agent.

Healthy transcript history does not require stopping the Gateway just to record
historical migration completion. Doctor defers that bookkeeping while any agent
database is in use. History that actually needs repair still requires exclusive
maintenance custody.

SIGINT and SIGTERM cancel Doctor's preparation before it stops a Gateway or
starts repairs. If repair already owns state, Doctor settles its admitted work
and restores any service it stopped before exiting.

If a native SQLite snapshot request fails, Doctor exits with an error even when
an optional check defers its work. Resolve the reported snapshot or filesystem
failure before retrying; a deferred check does not certify a successful inspection.

## Postures

Doctor supports these postures:

| Posture                   | Command                                   | Behavior                                                                              |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| Guided checks             | `openclaw doctor`                         | Interactive health flow; can copy legacy config and apply automatic state migrations. |
| Advisory JSON             | `openclaw doctor --json`                  | Read-only findings; exits successfully after producing a report.                      |
| Repair                    | `openclaw doctor --fix`                   | Applies supported repairs, using prompts unless non-interactive repair is safe.       |
| Lint                      | `openclaw doctor --lint [--json]`         | Read-only findings with threshold-based exit codes for CI gates.                      |
| Shared SQLite maintenance | `openclaw doctor --state-sqlite compact`  | Explicitly checkpoints, compacts, and verifies the shared state DB.                   |
| Session SQLite tools      | `openclaw doctor --session-sqlite <mode>` | Inspects or maintains SQLite sessions and explicitly imports legacy history.          |

Use `openclaw doctor --json` when an operator or script wants the advisory Doctor report as JSON. It exits successfully after producing a report; inspect `ok` and `findings` for health state. Use explicit `openclaw doctor --lint --json` when CI should exit nonzero for findings at the selected severity threshold. Prefer `--fix` when a human operator wants Doctor to edit config or state.

For read-only diagnosis, use `--lint` or bare `--json`. Ordinary `doctor`, including `doctor --non-interactive`, can copy legacy config and migrate state even without `--fix`. `--non-interactive` suppresses prompts, not writes.

Interactive `doctor` first checks shared schema compatibility and can offer a
source update. If the update does not take over, Doctor checks all database
schemas before asking to pause the matching managed Gateway while you review repairs. Accepting takes maintenance custody, keeps individual repair
prompts, and restores the service's prior state after database handles close.
Declining skips repairs and continues the same invocation with read-only
`--lint` checks, without changing the service or persisted state or asking for
repair approvals. The report exits `1` if it finds warnings or errors, otherwise
`0`. Existing `--deep` and `--allow-exec` selections still apply. Externally supervised or
unmatched Gateways remain subject to their existing maintenance ownership checks.

When ordinary `doctor` asks **Apply recommended config repairs now?**, it checks
that the selected root config file still matches the source of that proposal.
If its contents or selected path changed before the write, Doctor preserves the newer file,
leaves the pending config fixes unwritten, and exits with an error. Rerun
`openclaw doctor` to review an updated proposal.

If saving succeeds but later processing fails, Doctor stops with an error, names
the file that was written, and reports whether the write was rolled back. When it was not rolled
back or recovery could not be confirmed, inspect that file and the active config
before rerunning Doctor.

If the shared state database uses a newer schema, Doctor refuses before offering
an interactive update because update admission also needs that database. Run
Doctor from the OpenClaw install that wrote the state, or another compatible
build. A readable shared database still permits an interactive source update
when agent databases use newer schemas; if the update does not take over,
Doctor checks all database schemas again before diagnostics or repair. See
[Database schemas](/reference/database-schemas).

After an exec-approval format upgrade, Doctor reports older generated approvals
that are no longer active because they were not tied to a working directory.
`openclaw doctor --fix` removes those inactive generated entries and leaves
manual allowlist rules unchanged. Rerun affected workflows and choose
**Always allow here** to renew trust for the intended directory. The normal
`openclaw update` finalization runs this safe repair automatically.

Explicit repair stops the matching managed Gateway and checks Gateway, state,
and agent-database ownership before taking read-only schema snapshots. It
excludes other processes during repair, then restarts the same service once
and verifies readiness. Policy refresh preserves the installed launcher and
environment. Separately, [eligible installation drift](/cli/doctor/recovery#gateway-service-recovery)
in a previously running service is reconciled through the native installer.
Automatic installation refresh covers installation-only drift; other operator
edits or uncertain inspection still require interactive confirmation. Services
confirmed offline before maintenance keep their launcher and stop state; Linux
policy can refresh without activation as described below. Use the reported
profile-aware `openclaw gateway install --force` command to reconcile their
installation drift (installation may start the service). On Linux, Doctor also
restores a previously running service if systemd unloads the stopped unit during
repair; a changed service definition or manager still blocks restart. A loaded, enabled
macOS job between respawns is not offline: Doctor stops it before repair and
resumes it afterward. Run repair from a shell outside the Gateway process tree. For externally supervised or unmatched installations, stop
and start the Gateway through its owning supervisor.

After pre-repair backups complete, Doctor checks update conflicts against current
committed rows through its retained read-only maintenance connection. These checks
share Doctor's repair scope with managed-service continuation checks, avoiding
repeated whole-database scans with or without a cached writer.
Pre-repair inspections still preserve the source database and its sidecars.

Before a Linux maintenance stop, Doctor backs up and refreshes outdated OpenClaw
unit policy and confirms `daemon-reload`. Operator drop-ins remain unchanged.
The current service stop policy is 330 seconds. A resident Gateway can still have
an older, shorter shutdown budget: published 2026.9.5 cached that budget at startup.
For a short or unreported resident budget, maintenance asks the Gateway to fence
new admission and drain existing work, stopping as soon as it reports idle.
The wait uses the update's existing per-step deadline (30 minutes by default).
At that deadline, admitted turns may be interrupted with a warning; a reported
write-custody phase, such as session mutation or terminal persistence, refuses the
stop and names its owner phase. Older residents without the custody observation
stop at the deadline with a warning naming active root requests and cron runs;
unknown custody is not a refusal. An owned service confirmed offline can receive
the policy refresh without being started.

Unattended update and Gateway startup failures collect
[diagnostics only](/cli/triage#automatic-failure-handoff). An older, already admitted
managed repair handoff can remain active across an upgrade. In that subtree, repair can run
against an offline target when schema and maintenance locks permit it. If repair
needs to stop the managed Gateway, Doctor refuses inside its automatic fixing
subtree because that stop would cancel recovery. Use read-only diagnosis or safe
offline artifact repair followed by an atomic `openclaw gateway restart`, or ask
an independent operator to run Doctor from a shell outside triage.

Read-only database snapshots and initial integrity scans have a 30-second
execution limit per database. A timeout names the database and asks you to stop
its Gateway service and other OpenClaw processes before retrying. If all writers
are stopped, inspect storage performance and the reported database; a timeout
does not prove corruption.

`openclaw doctor --fix --non-interactive` applies the supported migrations that
block Gateway startup without prompting, including shared-state audit schema,
legacy workspace setup, legacy session stores, and exec approvals. Malformed or
conflicting input is retained and requires the manual action in the diagnostic.
The updater uses this repair path before accepting the installed target.

Gateway, node, and macOS app startup prepare pending client credentials automatically,
including profiles that were offline during the update. Preparation keeps existing
identities and pairing tokens and captures a backup before retiring their old storage.
Native clients can invoke the same operation with
`openclaw doctor --client-credentials --repair --non-interactive`. This command only
prepares the selected root's client credentials and required source schema. It does not
run health checks or control services. Add `--json` for a completion report.

If a replacement host retains PostgreSQL state but loses `client/credentials.sqlite`,
restore the matching credential backup when available. Without a backup, run:

```bash
openclaw doctor --fix
```

Doctor reports the missing local credentials and asks before creating new identities.
Clients on this host get new identities and must re-pair. Paired remote devices
keep working; their pairing records stay in PostgreSQL. Retained legacy identity
and token JSON files remain retired. To accept the repair without prompting, use
`openclaw doctor --fix --yes` (or `--repair --yes`). `--non-interactive` without
`--yes` does not rebind identities; it reports `openclaw doctor --fix --yes` as the
next step because this identity change is not a safe migration.

Ordinary startup never rebinds automatically and points to `openclaw doctor --fix`.
This repair applies only to an entirely absent local credential store with
PostgreSQL state. It does not replace a present store or change SQLite recovery;
mismatched, incomplete, unsafe, and corrupt local stores keep their existing refusals.

Migration checks default to whole-database `quick_check`, full integrity checks
for tables the migration rewrites or re-indexes, and foreign-key checks. Add
`--full-integrity-check` to check every table and index during migration:

```bash
openclaw doctor --fix --full-integrity-check
```

The default can miss an index/table mismatch in an untouched table. Explicit
verification, recovery, and compaction keep their existing checks. See
[migration integrity checks](/install/updating#migration-integrity-checks) for
the coverage and installed-updater boundary.

Update-time Doctor runs startup-required repairs before optional inspections.
When the installed updater supports post-restart inspections, Doctor moves
lint-backed, inspection-only checks out of the stopped Gateway window. The
updater runs them after restart and saves their findings in the
`post-activation doctor inspections` result step. Findings or an incomplete
inspection remain advisory and do not fail an otherwise successful update.
Repairs, migrations, readiness gates, and checks without equivalent lint
coverage keep their existing ordering. Older installed updaters keep the
inspections in their original Doctor pass.

On large fleets it can defer auth and model diagnostics, plugin inspection,
skills and workspace metadata, session-snapshot inspection, and advisory lint to
reserve time for required repairs and update validation. Each deferred check
appears as an `update-inspection-deferred` warning in Doctor output and the
update outcome, with the reason and remaining inspection allowance. A deferred
check did not pass or fail; it was not run.

Run `openclaw doctor --fix` after activation to complete those checks and review
optional repairs. An ordinary Doctor run does not retain the update's inspection
limit. Required session, database, workspace-state, and exec-approval readiness
checks still run during the update. Project-clone inspection, SQLite database-size
advice, and workspace backup and memory suggestions retain their standalone scope.

This maintenance window also applies when repair ultimately finds no changes.
Non-interactive runs without `--fix`, `--repair`, or `--yes` do not enter
maintenance. Ordinary interactive runs enter only after custody consent.
Custom state directories remain runtime-only and do not adopt a native service.

`--force` alone does not select repair mode: `openclaw doctor --force` remains
guided and still requires interactive consent before an eligible service rewrite.
With `--fix`, `--repair`, or `--yes`, it allows aggressive config/state repairs
with the same installation-drift and Linux policy-refresh rules above. Force does
not bypass service
ownership, write-access, or interactive-only confirmation requirements.

<Warning>
  `doctor --fix` follows explicitly configured workspace and store paths, including
  paths outside `OPENCLAW_STATE_DIR`. Setting `OPENCLAW_STATE_DIR` and
  `OPENCLAW_CONFIG_PATH` to a copy does not redirect those paths. Before rehearsing
  repairs on copied state, copy the external workspaces and stores too, then rewrite
  their paths in the copied config to point to the copies. Otherwise, Doctor can
  modify the originals.
</Warning>

During an update, Doctor respects the updater's service activation policy.
If the running Gateway has an old version/build or cannot load its WebSocket
handler after package replacement, Doctor stops that stale instance through
the verified service manager and confirms its process and listener are gone.
It retains service custody while running offline repairs, including legacy session
imports, then restarts the service and verifies the candidate's version and build
ID over RPC. Startup can require those imports, so candidate readiness is checked
after maintenance. A warning names the replaced PID and verified serving build.
HTTP health alone does not prove recovery. A refused stop or unverified restoration
records the failed phase and exact recovery commands in the update result.

Legacy post-core convergence retains service maintenance custody while its fresh
Doctor processes run, then restores the Gateway before publishing completion.
An ordinary healthy Gateway still follows the parent's activation policy;
`openclaw update --no-restart` does not grant state-repair access to a live writer.

Unavailable service inspection becomes a warning and grants no service-control
authority. Doctor still checks Gateway/state coordinators, agent-database leases,
and the temporary-file lock used by older Gateways such as 2026.6.33 before
repair. A live or unverifiable legacy lock owner blocks repair and names its PID
and lock path; stop that Gateway through its service owner, then run
`openclaw doctor --fix` from an independent shell. An unmatched service that can
still run also blocks maintenance; inspect it with `openclaw gateway status --deep`.
Once the native manager confirms it is offline, Doctor can repair its selected
state without changing or starting that service. A stopped or disabled systemd
unit need not remain loaded in the manager for state repair to proceed.

If migration or config repair cannot finish, Doctor leaves the stopped service
stopped and reports an incomplete repair with exit code 1. When state requires
manual recovery, the diagnosis names its path and the next action:

- **Unsupported workspace version:** use an OpenClaw build that supports
  that version. Preserve the shared database unchanged.
- **Unreadable or conflicting exec policy:** stop the Gateway and node hosts,
  then reconcile the named legacy file or interrupted claim with a verified copy
  of the intended policy. Preserve the existing SQLite policy.

Doctor does not quarantine unsupported workspace state, discard future-version
rows, or infer execution policy. Repeating the same repair invocation cannot
resolve these conditions. After manual recovery, verify readiness before starting
the service through its owner.

Doctor prints each check or repair section to stderr when it starts. Sections
still running after 10 seconds repeat their name with elapsed time every 10
seconds. JSON output does not include these progress messages.

## Examples

```bash
openclaw doctor
openclaw doctor --lint
openclaw doctor --json
openclaw doctor --lint --json
openclaw doctor --lint --severity-min warning
openclaw doctor --lint --all
openclaw doctor --lint --allow-exec
openclaw doctor --deep
openclaw doctor --fix
openclaw doctor --fix --non-interactive
openclaw doctor --generate-gateway-token
openclaw doctor --post-upgrade
openclaw doctor --post-upgrade --json
openclaw doctor --state-sqlite compact
openclaw doctor --state-sqlite compact --json
openclaw doctor --session-sqlite inspect --session-sqlite-all-agents
openclaw doctor --session-sqlite dry-run --session-sqlite-agent main --json
openclaw doctor --session-sqlite import --session-sqlite-all-agents
openclaw doctor --session-sqlite validate --session-sqlite-all-agents --json
openclaw doctor --session-sqlite compact --session-sqlite-all-agents
openclaw doctor --session-sqlite recover --github-issue
openclaw doctor --session-sqlite restore --session-sqlite-all-agents
```

For channel-specific permissions, use the channel checks instead of `doctor`:

```bash
openclaw channels capabilities --channel discord --target channel:<channel-id>
openclaw channels status --probe
```

`channels capabilities` reports the bot's effective permissions for a specific channel target. `channels status --probe` audits all configured channels and voice auto-join targets.

## Options

| Option                          | Effect                                                                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-workspace-suggestions`    | Disable workspace memory/search suggestions.                                                                                                                                                                                                          |
| `--yes`                         | Accept defaults and enter repair maintenance without prompting.                                                                                                                                                                                       |
| `--repair` / `--fix`            | Apply recommended repairs while coordinating maintenance with the matching managed Gateway (`--fix` is an alias). Refresh outdated Linux policy and reconcile eligible running-service installation drift; preserve stopped launchers and stop state. |
| `--replace-model <json>`        | With `--fix` or `--repair`, explicitly replace a retiring Daybreak alias with a specific OpenAI model and Access program. Repeat for both aliases; see below.                                                                                         |
| `--force`                       | Allow aggressive repair choices. Alone, remains guided; with `--fix`, `--repair`, or `--yes`, uses the same policy-refresh and installation-drift rules.                                                                                              |
| `--non-interactive`             | Run without prompts; safe automatic migrations still apply. Combine with `--fix`, `--repair`, or `--yes` to enter repair maintenance.                                                                                                                 |
| `--client-credentials`          | Prepare only client credentials and their required source schema. Requires `--repair` or `--fix` with `--non-interactive`; optionally accepts `--json`.                                                                                               |
| `--generate-gateway-token`      | Generate and configure a gateway token.                                                                                                                                                                                                               |
| `--allow-exec`                  | Allow doctor to execute configured `exec` SecretRefs while verifying secrets.                                                                                                                                                                         |
| `--deep`                        | Scan system services for extra gateway installs; report recent Gateway supervisor restart handoffs.                                                                                                                                                   |
| `--full-integrity-check`        | Use full database integrity checks during migrations instead of the default quick check plus full checks of affected tables.                                                                                                                          |
| `--lint`                        | Run the [structured health checks](/cli/doctor/health-contract) in read-only mode and emit diagnostic findings.                                                                                                                                       |
| `--post-upgrade`                | Run post-upgrade plugin compatibility checks; findings go to stdout; exit code 1 if any error-level finding is present.                                                                                                                               |
| `--state-sqlite <mode>`         | Run explicit shared state SQLite maintenance. The only mode is `compact`.                                                                                                                                                                             |
| `--session-sqlite <mode>`       | Run targeted session SQLite maintenance or legacy import: `inspect`, `dry-run`, `import`, `validate`, `compact`, `recover`, or `restore`.                                                                                                             |
| `--session-sqlite-store <path>` | With `--session-sqlite`: select a SQLite database or legacy `sessions.json` source, subject to the mode's [selection rules](/cli/doctor/sqlite-maintenance#session-sqlite-migration).                                                                 |
| `--session-sqlite-agent <id>`   | With `--session-sqlite`: select one configured agent.                                                                                                                                                                                                 |
| `--session-sqlite-all-agents`   | With `--session-sqlite`: select configured and discovered agent stores.                                                                                                                                                                               |
| `--github-issue`                | With `--session-sqlite recover`: prepare a sanitized openclaw/openclaw issue report; doctor creates it with `gh` after `--yes` or interactive confirmation.                                                                                           |
| `--json`                        | Emit read-only JSON. Bare `--json` is advisory; combine with `--lint` for threshold-based exit codes. With another machine mode, emit that mode's existing JSON report.                                                                               |
| `--severity-min <level>`        | With `--lint`: drop findings below `info`, `warning`, or `error`.                                                                                                                                                                                     |
| `--all`                         | With `--lint`: run all registered checks, including opt-in checks excluded from the default set.                                                                                                                                                      |
| `--skip <id>`                   | With `--lint`: skip a check id. Repeatable.                                                                                                                                                                                                           |
| `--only <id>`                   | With `--lint`: run only the given check id(s). Repeatable.                                                                                                                                                                                            |

`--severity-min`, `--all`, `--only`, and `--skip` are only accepted together with `--lint`. Bare `--json` uses the default read-only lint check selection but keeps Doctor's advisory exit behavior. Both read-only postures reject `--repair`, `--fix`, `--force`, `--yes`, and `--generate-gateway-token`. Explicit `--lint` also rejects `--session-sqlite` modes and their selectors, including `--github-issue`. Other machine modes can still use `--json` for their own output.

## Understanding findings

Normal Doctor output shows unresolved current problems under **Fix now**, with a
concrete next step and documentation. Blocking errors always appear, including
failures that require a plugin maintainer's help. Repaired findings disappear
from the final summary.

Optional improvements, informational results, and historical recovery notices
stay out of the default summary. Saving, retaining, or retiring a recovery copy
is bookkeeping, not a new problem. Recovery captures and updater warning receipts
remain unchanged; hiding a notice does not delete its evidence or acknowledge it.

To see full structured findings and recovery-copy locations during a diagnostic
run, use `openclaw --log-level debug doctor`. This uses existing debug logging;
see [Logging](/logging) for file locations and level configuration. For read-only
structured checks, use `openclaw doctor --lint --all --json --severity-min info`.
That report covers registered checks; it does not run repair-time migrations.

Successful repairs still appear as changes. Interactive prompts and repair
progress remain visible. Checks that have not yet adopted structured findings
retain their individual diagnostic panels.

### Auth and browser findings

Doctor reports unavailable, expired, or malformed credentials under **Fix now**.
Follow the provider-specific login command or credential correction shown in the
finding. Tokens that are still valid but nearing expiration are **Recommended
improvements**; refresh them before expiration to avoid an interruption. After
an accepted OAuth refresh, Doctor reports the remaining credential state rather
than the pre-refresh warning. Normal Doctor combines identical credential findings
across checked stores and names stores only when the finding affects a subset.
Read-only JSON and lint reports retain each store's path. See [OAuth](/concepts/oauth).

Browser findings distinguish missing executables, launch prerequisites, and
unsupported Chrome versions from optional setup. Healthy browser and manual
setup guidance stays informational in lint and does not make it fail; normal
Doctor omits this routine guidance. For Chrome extension setup,
Doctor does not inspect personal browser profiles or access the macOS Keychain.
If extension attach works, an uninspected bootstrap notice needs no action. If
attach fails, run `openclaw browser extension status --json`, then
`openclaw browser extension install` if repair is needed. These explicit commands
may request browser profile access. See [browser setup](/tools/browser/setup) and
[browser troubleshooting](/tools/browser/troubleshooting).

### Auth migration recovery

Auth imports retain their original warning receipts and recovery copies. The
final summary distinguishes the remaining work:

- **Fix now:** an auth source or SQLite owner cannot be inspected, an import
  cannot be verified, OAuth credentials are unavailable, or an alias would
  overwrite a different account. Follow the named path or account finding.
  Correct access or source errors before rerunning `openclaw doctor --fix`.
  For account conflicts, compare `openclaw models status` with your expected
  accounts and preserve both profiles before changing `auth.profiles` or
  `auth.order`. Do not delete the credential database to force an import.
- **Recommended improvements:** plaintext catalog credentials or retired
  profiles remain after declining a repair. `openclaw doctor --fix` verifies
  credentials in SQLite and cleans stale references. Native provider login
  remains unchanged when a retired CLI profile is removed.
- **Historical recovery notices:** an archive could not be finalized, an
  unparseable source was archived without import, or a verified catalog's old
  source could not be removed. Keep these copies. Check expected accounts with
  `openclaw models status`; if they work, retained data alone requires no
  credential repair. Correct the reported filesystem issue and rerun Doctor
  only to complete unfinished archival or cleanup.

A changed recorded account requires comparing the retained archive with the
current account before retrying migration. Do not overwrite a current account
or delete recovery data merely to clear a notice. For unavailable credentials,
use the configured provider's `openclaw models auth login --provider <provider-id>`
flow. Pre-June `oauth.json` requires the documented [2026.9.5 bridge upgrade](/install/updating#upgrading-very-old-versions).

## Daybreak alias migration

The Blue/Red aliases retire on October 28, 2026. Doctor does not infer their
successors. First check the specific model IDs and Access programs approved for
your account, then inventory the references:

```bash
openclaw doctor --lint --only openai/daybreak-alias-retirement
```

Use a JSON mapping with `--fix --replace-model`. For example, **only if your
account supports this model and Blue Access**:

```bash
openclaw doctor --fix --replace-model '{"from":"openai/gpt-daybreak-blue-latest","to":"openai/gpt-6.1-sol","accessProgram":"daybreak_blue"}'
```

Repeat `--replace-model` for Red if needed. Both references must use the
`openai/` provider; the source must be a retiring Blue/Red alias, and the
target must not be either alias. Choose `standard`, `daybreak_blue`, or
`daybreak_red` explicitly. This selects request behavior, not account entitlement.
It neither changes account pins nor grants Daybreak access.

Doctor saves the chosen target's model-scoped Access setting, then applies the
normal guarded model-reference repair to config, unlocked saved sessions, and
scheduled jobs. Model aliases, supported model settings, and account suffixes
are retained on the replacement. The chosen Access program overrides the old
alias's program; conflicting pre-existing target settings stop the migration.
Existing model-policy and pinned-account safeguards still apply. Cyber failover's
`mode` and `cooloffMs` settings are unchanged.

Before retargeting config aliases, Doctor expands saved session and cron aliases
to their original model IDs without changing their model, account, or Access
choice. This makes a retry safe if the process stops after saving config. A locked
alias or an incomplete store scan defers config retargeting; unlock the affected
selection or restore store access and rerun the same command.

Review the repair notes and rerun the read-only check. Locked sessions and
references with unsupported accounts or model policies may need manual changes.
The command uses Doctor's normal maintenance and backup workflow; it does not
perform a live inference or entitlement probe.
