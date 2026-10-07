---
summary: "Recovering from a failed `openclaw update`, plus the `update repair` and `update cleanup` subcommands"
read_when:
  - An update or repair failed and you need a working install back
  - You are running `openclaw update repair` and need its flags or exit codes
  - You want to inspect or retire migration recovery originals after an update
title: "Update repair and recovery"
sidebarTitle: "Repair and recovery"
---

What happens when an update fails, and the subcommands that finish the job. Part of the [`openclaw update`](/cli/update) reference.

## Recover a failed update

After a failed interactive update or repair, OpenClaw finishes cleanup and offers
**Diagnose update failure**, **Report update failure**, or **Exit**. Reporting
previews the sanitized issue body and requires separate confirmation.

Unexpected exceptions retain the known update mode, resolved target, failed step,
and any recorded recovery outcome. Reports include a bounded, redacted error code
or name and first message line through the same diagnostics as failed commands;
unrecognized private text and stack traces are excluded from the public preview.

Choosing **Diagnose update failure** opens [Triage](/cli/triage), which starts the
first directly launchable coding agent on `PATH`, in this order: Claude Code,
Codex, OpenCode, then Pi. It passes the captured update failure directly and leaves
fresh Doctor checks and diagnostics collection to the agent, so a broken installation does
not delay the handoff. The agent keeps its existing authentication, sandbox, and
approval settings.

The agent starts in the operator's original working directory, or their OS home
if that directory is no longer accessible. The failed installation's resolved
state, config, and default workspace paths remain pinned for the repair.

A verified rollback leaves the previous generation running. The interactive menu
selects **Exit** by default; declining or cancelling keeps the failed update's
nonzero exit status. After a verified rollback, `--json`, `--yes`, non-interactive,
and managed-service handoff runs do not prompt or collect automatic diagnostics.

For failures without a verified rollback, updates using `--yes`, `--json`, or a
non-interactive session (including piped input or output) collect diagnostics
and print handoff commands without starting an external coding agent. Eligible
failures can start [post-failure triage](/install/updating#unattended-repair-on-your-own-inference)
on configured inference after update ownership and service compensation settle. With `--json`, triage output goes to stderr so stdout retains
the original update result. Diagnostic collection failures never hide the update
failure.

For a background or Control UI failure, use the installation-specific command
printed on the Gateway host. Printed commands use PowerShell on Windows and
POSIX shells on macOS, Linux, and WSL. When running triage manually, keep the same
profile and state/config overrides:

```bash
openclaw triage
openclaw triage --agent codex
```

Use `openclaw triage --non-interactive` to collect diagnostics without starting
an agent. Add `--update-result <path>` to include a saved update-failure artifact.

When another process saves configuration during database admission, OpenClaw
warns and reads the current configuration again. It validates and uses that
configuration before continuing, retaining concurrent changes when applying
the requested update. If the root config or an included file changes after
candidate checks, it repeats those checks against the current configuration
before activation. A candidate that cannot accept the current configuration
still fails validation; a concurrent save alone is not a refusal.
If the save changes an implicitly selected update channel, OpenClaw resolves
the target again before execution. An explicit `--channel` keeps its selection.

Validation failures leave the serving Gateway untouched. If stopping the managed
service unloads it and then fails before activation, OpenClaw attempts to restore
the verified original runtime after rechecking service ownership. After activation, a
failed verification can [restore the previous package](/cli/update/how-updates-run#validation-and-activation)
when database schemas are unchanged and the config file still matches the
candidate’s activation Doctor output. Preserve migrated state and
history; replacing the code alone cannot undo a migration. The original
failed update still exits nonzero after the agent finishes, even if the repair
succeeds.

On Linux, systemd can unload an inactive unit after the updater stops it. The
owning updater reloads that unit's metadata when rechecking admission, retaining
the original manager and service identity. This does not start the service or
rewrite its definition. A later refusal still uses the recorded stop to restore
the previous Gateway; a service that was already stopped remains stopped.

After activation succeeds, a failure to read or publish update reporting leaves
the updated installation in place. Reporting failures do not trigger package
rollback. The command still exits nonzero when required finalization cannot
complete; follow its recovery guidance after the owning updater exits.

Activation Doctor rechecks the chat requester's authority inside its own live
maintenance scope. This lets it read authorization policy while the state database
is offline for repair, without granting access to unrelated operations. The
candidate supplies this repair even when an older updater launches Doctor.

Git updaters with database rollback support snapshot the stopped installation's
databases before activation Doctor. If Doctor fails, verified snapshots restore
the pre-migration state before the previous source, runtime, configuration, and
managed Gateway are restored. Doctor records its admitted and settled database
generations against that backup, so its own migration does not prevent rollback.
Later operator or runtime writes prevent destructive restoration: the updater
preserves them, restarts and verifies the Gateway on the migrated installation,
and reports the refusal with the next Doctor command. Lost ownership still
prevents unauthorized effects and retains the recovery artifacts. This rollback support
belongs to the installed updater; a new candidate cannot add it to an older
updater already running.

Dry runs and commands rejected by the initial argument, external-supervisor,
state-store ownership, handoff identity, or immutable-config checks do not
collect diagnostics or start an agent. Once those checks pass, failed metadata,
schema, runtime, and managed-service checks use the failure actions above even
when installation is blocked. This includes an update that cannot safely stop
its parent Gateway process. Diagnosis preserves that refusal: it does not stop the
Gateway, retry the update, or bypass safety checks. See
[Update troubleshooting](/install/update-troubleshooting).

### Original state captures

Before a fresh direct CLI update writes runtime state, the installed updater attempts to
retain the original config, its includes, local databases, and declared plugin
migration resources. The capture stays beside the selected state directory in
`<state-directory>.update-captures/<run-id>`. Doctor continuations keep the same
capture; they do not replace it with already migrated state. State-directory
relocation leaves its original location and recorded paths intact.
Inherited control-plane and managed-helper runs retain their existing capture
behavior. Standalone `doctor --fix` preserves a separate pre-repair copy; that
copy does not replace an earlier update's originals. Standalone `doctor --fix`
snapshots databases under its own maintenance custody with a single isolated backup worker.
Shared database families larger than 64 MiB keep discovery copies in an isolated process
so a slow copy does not block Doctor's main thread from processing cancellation.
Standalone Doctor captures are retained for 30 days: the next standalone `doctor --fix`
retires older sealed Doctor captures and reports each removal; incomplete captures
and update captures are never retired automatically, so take a verified backup
when you need a long-term copy.

These captures are evidence for manual recovery. Active writers can change state
during capture; an observed change leaves the capture incomplete and produces a
warning. The set is not an atomic snapshot across active stores. Missing,
unreadable, or incomplete captures do not establish a safe
rollback point. The updater process keeps optional debug-proxy persistence
disabled because its update history can use an older database schema. Doctor
can resume capture after preserving the originals and admitting the repaired
schema. A successful update that skips Doctor can therefore leave local HTTP
tracing disabled for that invocation.
Direct updates, including `--dry-run`, report this limitation when debug capture
is enabled.

Use `openclaw update status --json` to inspect retained evidence. Runtime rollback
does not prove that an earlier original capture was restored. Status reports that
capture as restored only when the restoration evidence identifies its manifest.
Standalone Doctor copies appear as `manual`; their presence does not record a
successful or failed repair. An unfinished capture appears as `incomplete`
alongside valid captures, with its directory and no sealed manifest reference.
Keep current data and inspect the originals before attempting restoration.
Older installed updaters may not preserve or forward an original capture; a
newer Doctor reports that limitation instead of treating current bytes as the
pre-update state. If capture discovery cannot verify an older driver's history,
Doctor warns and continues repairs under its existing maintenance and update
ownership. Required migration backups still apply.
Take a [verified backup](/install/updating#before-updating-create-a-verified-backup)
before an upgrade when you need a complete recovery copy.

### Retained updater runtime

An update can retain its running code in an `openclaw-update-runtime-*` directory
beside the installation or in the system temporary directory. The updater settles
its workers after success, failure, an exception, or `SIGINT`/`SIGTERM`, including
failures while reporting the outcome. Complete projections record
`Runtime retained at <path>: <reason>` for the next eligible update or Doctor
cleanup, so recursive deletion does not delay command exit. Incomplete preparation
keeps immediate best-effort cleanup. Unsettled workers retain their runtime with
the failure reason. A cleanup warning does not replace the original update
outcome. An earlier nonzero exit remains nonzero while workers are draining.
Mutation and recovery owners must still drain; their failures produce a nonzero
exit even if the printed command result was successful.

Retention copies plugin manifests and files inspected by plugin safety checks,
so retaining the updater does not make the checkout's plugins fail hardlink
validation. Other runtime files remain hardlinked when supported.

Updaters using `@openclaw/fs-safe` 0.23.1 or later rely on its guarded byte-copy
fallback when a container or filesystem refuses file cloning. Native filesystem
safeguards, source identity checks, file modes, snapshot verification, and SQLite
byte-copy space admission remain active. Genuine I/O errors still fail the copy.
This includes Proxmox LXC containers whose seccomp policy denies the `FICLONE`
ioctl; changing that policy is unnecessary for an updater using this dependency.
Do not globally disable native filesystem support to bypass cloning: Doctor's
state migrations require native safeguards.

These lifecycle and copying changes apply when the installed updater supports
them; installing a newer candidate cannot change the updater already running.
For the first hop from 2026.9.7 in an affected container, manually install a
release containing this fix with npm. Subsequent `openclaw update` runs inherit
the fallback from the installed updater's fs-safe dependency.

On Windows, interruption before activation still lets the admitted recovery
owner restore task autostart after pending task operations settle. Cancellation
fences new update work; restoration still requires the original live installation
owner and verified task ownership.
After that updater exits, run the newer `openclaw doctor --fix` from the original
checkout to locate its sibling runtime directories. Doctor also checks known
temporary directories, including the managed service's `TMPDIR`, `TMP`, and `TEMP`.
Relative service paths require its recorded absolute working directory. Legacy
pnpm projections remain recognizable after a versioned package-root change within
the same store; lookup is limited to 4,096 immediate projected-store entries. Recognized
runtime projections are disposable; Doctor removes them when no worker still
uses them. If ownership or process liveness cannot be verified, Doctor preserves
the directory and reports the reason.

## Candidate Doctor stack overflow

Chat-triggered updates to 2026.9.6 can fail with `authority-check-failed: Maximum
call stack size exceeded`, sometimes preceded by `Update history reconciliation
could not complete`. This is a candidate Doctor authority-check defect; it can
happen on the first update, without migrated state or earlier failed runs.
The corrective candidate can run through the installed updater with retained
history intact. Running the older installation's standalone Doctor cannot fix
code in the candidate package.

There is no supported command to reset retained update history. `update repair`
finishes interrupted finalization, and `update cleanup` retires eligible recovery
originals; neither clears the run ledger. Keep history and backups rather than
deleting database rows to work around this failure.

## Docker image-layer package updates

Docker OverlayFS can reject moving an npm package installed in an image layer
with `EXDEV`, even when the package and its backup are on the same mount.
Updaters with the copy fallback immediately retain and verify an independent
copy, record its identity for recovery, and remove the original before publishing
the candidate. A mismatched copy leaves the original package intact. The verified
copy remains available for rollback until activation is confirmed.

The first update from **2026.9.7 or 2026.9.8** still needs a manual installation
hop: those installed updaters run their own publication code, so the candidate
cannot supply this fallback. Prefer rebuilding the Docker image with the desired
OpenClaw version. For an in-container replacement, follow the
[manual update precautions](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun),
including a verified backup and stopping the managed Gateway, then run
`npm install -g openclaw@<version>`. Run Doctor and, if needed, `openclaw update repair`
from the new installation before restarting through the service manager.

## `update repair`

An older updater can leave package activation at `prepared` after refusing an
update before publication. Run `openclaw update repair` from an installation
containing this fix. Repair verifies that the original package and launchers are
unchanged, aborts the unused preparation, and retires its recovery artifacts so
the next update can proceed. It does not publish the staged candidate. An active
updater, changed package or launcher, or unfinished state restoration keeps its
existing recovery checks. A candidate cannot patch the older updater already
running; use the manual installation hop below if the installed CLI lacks this
repair.

For a publication stranded at `publishing` after an external write, repair can
close it as `publication-settled-external-change` when the installed build-info
reports the exact candidate version, every file in the package's own dist content
inventory still matches, the original helper's seal verifies, and no updater owns
the installation. The root `package.json` must parse with name `openclaw`, the
candidate version, and type `module`; every `main`, `exports`, and `bin` target must
resolve to a file in the package. Targets within `dist/` must be inventoried;
top-level targets such as `openclaw.mjs` are checked for resolution without content
verification. Extra `package.json` files under `dist/` refuse settlement because
they can change how inventoried code loads. Dependency manifests under
`node_modules/` are expected and ignored. Other extra dist files remain warnings.
Restore any changed inventoried file to its packaged bytes before retrying; a
working Gateway alone does not waive an inventory failure. Repair preserves the
previous package and sealed helper, leaves the installed package and launchers in
place, and records the warning and extra paths in update history. The warning and
receipt identify the root manifest as field-verified, not content-verified. The
sealed tree digest cannot identify old per-file metadata differences. Use a CLI
containing this fix; the original sealed helper keeps its original recovery checks.

For a package update stranded by an older updater's launcher ownership checks,
use the manual installation hop, then repair from the new CLI at the same root:

```bash
npm install -g openclaw@latest
openclaw doctor --fix
openclaw update repair
```

Follow the [manual update precautions](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun),
including a verified backup and stopping the managed Gateway during replacement.
When the installed package directory matches neither recorded generation, repair
closes the previous package operation as `superseded-by-manual-install`, warns with
its operation ID, and preserves its staged files and helper beside the installation.
The original failed history entry remains intact. The pending package-recovery
gate then clears, so another update can proceed. Other same-identity recovery keeps
its original sealed-helper checks; missing packages, active update owners, and pending
database or configuration restoration still require their existing recovery path.

If recovery instead reports `managed handoff lease database identity changed`,
run `openclaw update repair` from a CLI containing this fix. Repair acquires fresh
update ownership on the current lease database and closes the orphaned package
operation as `recovery-lease-identity-changed`. It warns with the old operation ID
and retained artifact path, leaves the installed package and launchers in place,
and clears package admission for the next update. The original helper cannot
recover against a replaced lease database. Matching lease identities keep the
original recovery checks; another live update owner still prevents settlement.
No recovery artifacts are deleted. An older installed CLI cannot obtain this fix
from a candidate it has not yet staged; use the manual installation hop above.

The same repair handles `ENOENT` when the recorded handoff lease database is
missing, for example after a reboot clears a temporary filesystem. Its storage
owner recreates the lease database, and repair acquires fresh update ownership
before closing the orphaned package operation as `recovery-lease-missing`.
The installed package, launchers, and retained recovery evidence keep the same
protections. Repair then continues through Doctor and plugin convergence;
plugin data/settings warnings clear only when their migration owners complete
the required work. Remaining warnings name the next repair action.

Rerun update finalization after the core package already changed but later
repair work did not finish cleanly. This is the supported recovery path when
`openclaw update` installed the new core package but post-core plugin sync,
managed npm plugin metadata, registry refresh, or doctor repair did not
converge.

```bash
openclaw update repair
openclaw update repair --channel beta
openclaw update repair --json
openclaw update repair --accept-capabilities
```

An interrupted automatic triage can leave an uncertain installation handoff after
its updater and helper exit. Explicit `openclaw update repair` can reclaim that
handoff when both recorded PID/start identities are provably dead, a complete
host census finds no remaining references to its run or retained paths, and at
least 45 minutes have passed since the lease's last recorded activity. A
recoverable larger recorded timeout extends that grace period. Gateway startup
and borrowed update processes do not reclaim these leases.

The original run must be identifiable from its retained helper, update history,
or generation-bound repair metadata, and readable in the selected state database.
Repair needs that record to check rollback and recovery evidence. Use the same
profile and state overrides as the failed update; repair does not substitute a
lease owner ID for a missing run.

Refusals name the processes, inspection gap, or remaining grace period. Stop
named work through its owning terminal or service, then retry; do not delete the
lease database. Repair retains unreadable helper paths in its census instead of
assuming their work has stopped.

On Windows, identifying foreign process owners can require Administrator privileges.
If repair requests elevation, use the same Windows account and preserve the failed
update's profile and state overrides. Unknown ownership remains unverified.

When no rollback step is recorded, repair uses ordinary current-installation
finalization and records a handoff settlement in update history before releasing
ownership. It preserves retained artifacts and does not invent an owner-death
time or previous Gateway state. Unresolved state restoration keeps its existing
recovery safeguards. A failed repair retains its original evidence, bound to the
new lease generation, for a later explicit repair.
Each repair attempt records its own run before starting finalization work, so a
later repair also checks for descendants of interrupted repair attempts.

An unfinished package or configuration rollback keeps the handoff and its artifacts
intact. Inspect `openclaw update status --json` and complete the recorded restoration
before retrying repair. Verified completed rollback and settlement receipts permit
repair, including installations without a running Gateway. Skipped rollback steps
and diagnostic warnings alone do not prevent repair.

When update, post-core continuation, or repair runs under Bun, its OpenClaw
maintenance children use that same Bun executable, including fresh Doctor,
config validation, readiness, completion, and non-interactive failure diagnostics.
Managed-service runtime selection stays with the service definition and its runtime pin.

If an older updater publishes the new core but then reports
`update-executor-settlement-failed` with `Parent executor is suspended for its candidate.`,
wait for that updater to exit and run `openclaw update repair --yes --json` from
the updated installation, preserving its profile and state/config overrides.
This finishes Doctor and post-core convergence through a fresh owner. Check the
repair result before restarting an already stopped Gateway through its service
owner. Updating the candidate cannot change the older updater already in memory.

When a managed Gateway was already stopped before standalone repair, repair leaves
it offline and warns that you must run `openclaw gateway start` to bring it online.
If its service definition points to a different installation, repair instead reports
the installation repair command. These maintenance warnings also appear in
`postUpdate.doctor.warnings`; otherwise successful finalization reports
`status: "warning"` and exits successfully.

| Flag                                             | Description                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--channel <stable\|extended-stable\|beta\|dev>` | Persist the core update channel before repair. For extended-stable, eligible official npm and trusted official ClawHub plugins that follow bare/default or `latest` intent target the exact installed core version. Extended-stable repair is rejected on Git checkouts without changing config. |
| `--json`                                         | Print machine-readable finalization JSON.                                                                                                                                                                                                                                                        |
| `--timeout <seconds>`                            | Override each repair phase deadline in seconds. Defaults vary by phase (see below).                                                                                                                                                                                                              |
| `--yes`                                          | Skip confirmation prompts.                                                                                                                                                                                                                                                                       |
| `--accept-capabilities`                          | Accept each plugin's reviewed capability changes while repairing plugin state.                                                                                                                                                                                                                   |
| `--no-restart`                                   | Accepted for parity; repair does not request update activation. The repair parent restores a Gateway it stopped for maintenance.                                                                                                                                                                 |

Untouched, identityless 2026.9.2-era update admissions heal automatically after
more than 24 hours. Gateway startup, `openclaw update status`, and `openclaw status`
retain the row as an abandoned failure with reason `legacy-driver-expired` and an
advisory to run `openclaw update` to retry. The Control UI refreshes the Gateway's
recovery classification before refusing a suspended config write, so an expired
orphan does not keep settings or provider sign-in blocked. Live updates and
pending recovery remain protected. No explicit repair is needed for this shape.

`update repair` first inspects stale update history. When the installed Gateway
generation is healthy and the only remaining problem is an inactive ledger row,
repair records `failed` / `abandoned` and exits successfully without Doctor,
maintenance, or a service stop. `openclaw status` and the Control UI then report the abandoned run as reconciled, without a failure warning or retry prompt; its historical failure record remains intact. It also acknowledges a Gateway-reconciled row
once within 30 minutes of reconciliation. Later repair invocations use full
finalization, so historical recovery cannot suppress plugin convergence.
Successful repair acknowledges every outstanding abandoned run in Doctor's
latest 100 history records, regardless of age or whether a newer update exists.
The original failed outcome remains recorded, including when its target build
is unknown; Doctor stops repeating the repair instruction after acknowledgement.
Explicit recovery does not wait 30 minutes when every recorded updater process
is provably dead (its PID is gone or its process-start identity has changed).
Identityless rows and runs with an unrecorded adopter still require more than
30 minutes of inactivity; a recorded live or uninspectable driver blocks
abandonment recovery.
JSON output identifies reconciled run IDs in
`reconciledRuns`, with `status: "ok"`, `mode: "repair"`, and `restart: false`.

Repair also acknowledges an untouched package installation whose update was
refused because its package-manager owner was unknown, once the installed
version meets or exceeds the resolved target. This includes older updaters that
incorrectly recorded that refusal as a failed update. The original refusal
detail stays in history; repair clears the failure prompt without Doctor
maintenance or a service restart. Runs that reached installation or finalization
still require normal repair.

Fresh Doctor children run with the existing external service-repair policy
because the updater owns service changes. They preserve an operator's
`OPENCLAW_SERVICE_REPAIR_POLICY=external` selection and retain Gateway/state
coordinators and agent-database lease checks. An external deployment owner still
owns stopping and restarting its Gateway.

Automatic repair finishes its embedded agent turn and releases that turn's database
and process resources before asking the update owner to run Doctor or update repair.
This prevents the repair agent's own credential writes from blocking maintenance.
Other live agent leases still block repair. Maintenance preserves the original
Gateway activation intent, including `--no-restart` and intentional stops. A
successful maintenance command alone does not verify the original symptom.

Repair invoked within the owning update can continue when its inherited run ID
and live process identity match that owner. Standalone repair records the same
continuation for its new run and passes that run ID to its Doctor children.
The repair parent uses Doctor's maintenance lifecycle to stop the owned Gateway,
then releases its database locks before running the Doctor children. The children
repair state without stopping or restarting the service. The parent restores and
verifies the same service after convergence, including when a Doctor child fails.
An already stopped service stays stopped. Service ownership and the invoking
run are revalidated before every native operation. A restoration failure names
the cause and the commands to inspect and restart the Gateway. Normal update
finalization continues to leave activation with its outer updater.

If Doctor reports that the update parent must stop the managed Gateway, wait
for that update to exit, then run `openclaw gateway stop` and retry
`openclaw update repair` from an independent shell with the same profile and
state/config overrides. On macOS, stop unloads the LaunchAgent and verifies that
its process exited. A still-loaded service or surviving PID after a successful
stop is a service shutdown failure. If stop cannot unload the service, use the
exact `launchctl bootout` command printed in the refusal from the owning user's
logged-in macOS GUI session.

An unrelated update whose driver is live or cannot be inspected still blocks
repair, even after a long period without activity. Manual `doctor --fix` also
refuses to stop a service while that update is active. The refusal identifies the
owning run, phase, driver PID, host, start and last-activity times and ages, and observed liveness (`alive` or
`not observed`). Wait for that update to finish, or stop the named driver on its
host and rerun `openclaw update repair` after it exits. Elapsed inactivity alone
does not authorize taking over a live updater.

Explicit channel or capability changes and known incomplete post-core work use
full finalization. Recorded activation, restart, verification, or finalization steps require
that convergence even if the Gateway has already reconciled the run. Repair
checks newer failed post-core history as well as active rows, including older
finalization attempts with an empty failure reason; an older stale row cannot
hide unfinished work from a newer update. If the bounded history inspection is
incomplete, repair also uses full finalization. The parent parks its owned service
before Doctor enters maintenance; a Doctor child cannot take service activation
from an update parent.
Successful full finalization then reconciles the selected stale rows and acknowledges
unacknowledged abandoned outcomes from the 100 most recent history rows captured
at repair admission. Those outcomes need not be the latest run or less than
30 minutes old; the time limit applies only to skipping full finalization.
Additional historical outcomes require full finalization, even when the latest
row qualifies for the lightweight repair. Historical failures and their details
remain intact; acknowledgment clears their Doctor repair prompts, not their failed
status. Rows outside the captured history window and new runs admitted during
repair are not acknowledged by that invocation.
Failed convergence leaves the selected rows intact. If any selected run resumes
before reconciliation, the whole selection is preserved. Full finalization JSON
includes `reconciledRuns` when rows were selected for recovery, listing the IDs
newly acknowledged by that invocation, including already-terminal abandoned rows.
Successful convergence with nonfatal warnings also acknowledges those rows.
Deferred maintenance preserves the selected history and pending migration obligations.

For full finalization, `update repair` runs `openclaw doctor --fix`, reloads the repaired config and
install records, syncs tracked plugins for the active update channel, updates
managed npm plugin installs, repairs missing configured plugin payloads,
refreshes the plugin registry, and writes converged install-record metadata.
If plugin migrations remain deferred, finalization runs another fresh Doctor after
releasing install-record ownership, even when no plugin package changed. This lets
a corrected local plugin finish its pending confirmation in the same repair run.
Doctor preserves the plugin's configuration when compatibility checks prevent
discovery, so correcting the plugin does not require recreating its allowlist or
enabled entry.
Configured runtime plugins whose versions follow OpenClaw are checked against
the newly installed core during post-update repair, even when the updater process
started on the previous version.
It does not install a new core package or request update activation. The repair
parent restores a service it stopped for maintenance, as described above.
Human output ends with a finalization result that distinguishes completion,
completion with warnings, and failure.

When repair finds a configured npm plugin payload but cannot recover its install
record, it reinstalls from the selected registry source, using the active channel
or exact version pin. This requires registry access; if verification fails, repair
preserves the existing payload and does not publish a new install record.
Registry verification and any required capability review finish before the
repaired install record is published.

When a bundled plugin moves to an external package, failed relocation reports
that the replacement payload was not installed and preserves the underlying error.
Resolve that error before retrying with `openclaw update repair`.
Doctor and update repair reinstall configured payloads with missing package files
or a reported missing runtime entry;
an empty directory is not a successful installation. Rollback removes empty
managed npm projects after staged files are cleaned up. Doctor preserves external
companion packages and their install records even when a source checkout also
contains a bundled-discovery copy of the same plugin. Repair diagnostics must identify the recorded
package root; a broken same-ID source copy does not trigger replacement of a
healthy managed package.

With `--json`, stdout contains one JSON document. Doctor panels and other
diagnostics go to stderr, so stdout can be parsed directly. Plugin-only
availability, installation, or load failures appear in
`postUpdate.plugins.warnings`; finalization reports `status: "warning"` and exits
successfully when required checks pass. Doctor maintenance admission refusals
also finish with a warning when no data is at risk. Repair restores any service
it stopped, leaves migrations pending, and names the next repair action. Errors
after repair writes begin, a live or unverified Gateway, unreadable state, active migration writes, unsettled
cleanup, invalid configuration, and failed required readiness checks still exit nonzero.

If a required repair phase exceeds its deadline, repair exits with code 1 and JSON reports
`status: "failed"` with the `stuckPhase`. That result remains available after
service restoration, including when the Gateway is still starting or restoration
also fails. A startup warning after otherwise successful Doctor repair does not
clear a repair phase timeout.

Recorded pending-migration warnings stop appearing after the migration owner
records completion. Unrelated warnings and later or reintroduced obligations
remain visible; the original update history is preserved.

After post-update or finalization work fails and its child processes settle,
OpenClaw checks the installed Gateway using the normal startup and readiness
budget. If maintenance found no Gateway service or listener, recovery records
that readiness observation was skipped instead of waiting for a Gateway to appear.
Package and database restoration checks still apply, and the original failure
remains recorded. Update history and failure reports record the observed serving version
and readiness. A standalone repair failure before Doctor maintenance begins uses
one bounded observation because that repair has not requested Gateway startup.
Observations also cover foreground Gateways. A failed finalization step
can therefore report **verified serving** while retaining its original failure
and repair guidance. The observation does not restart the Gateway or grant
maintenance authority. Failed checks retain their specific diagnostic; a
Gateway that is still starting keeps that outcome instead of being restarted.
If command cleanup remains uncertain, the run stays open and retains its recovery
artifacts instead of publishing completion or starting another repair.

Doctor repair uses the same enabled-plugin and default-check selection as
ordinary Doctor lint. Opt-in checks, including the managed Codex version check,
do not run during routine finalization. Explicit candidate checks still run
when requested with `doctor --lint --only codex/managed-app-server`.
The version check has a five-second deadline, terminates its process group
where supported, and bounds output draining when a descendant retains a pipe.
A timed-out check cannot be accepted merely because its direct child exited
successfully. Nonfatal Doctor warnings appear in `postUpdate.doctor.warnings`;
finalization reports `status: "warning"` and exits successfully when no other
step fails. Codex runtime readiness remains owned by its plugin after restart.

Finalization (including the supervisor-facing `update finalize` command) records
phase starts and finishes immediately on stderr and in the update run ledger.
Preflight admission, config validation, config backup, and core completion-cache
budgets scale with the shared SQLite database and its sidecars, with a five-minute
startup allowance and conservative disk throughput. Repair Doctor and its enclosing
convergence phase have no automatic wall-clock deadline. Post-plugin config and
readiness checks share a budget derived from the existing shared and discovered
agent database families after Doctor finishes, including WAL growth. Plugin
updates retain the command owner's 20-minute allowance; missing-plugin repairs
retain their installer defaults. The serial plugin phase and
outer finalizer process add no competing default deadline. An explicit `--timeout`
still overrides each phase and its child commands.

A phase deadline produces exit code 1 and JSON with `status: "failed"`,
`stuckPhase`, `elapsedMs`, `error`, and the existing `phaseTimings` array. The
finalizer cancels the phase, fences further writes, and waits up to the same
budget for its work to settle. Repair restores and verifies the Gateway it
stopped before reporting the failure and exiting. Service custody acquisition
and restoration retain their own native-operation budgets outside phase
cancellation. The ledger records a warning naming the timed-out phase and budget.
Preserve the phase diagnostic when reporting a stalled update.

When a fresh Doctor ran in the timed-out phase, `doctorOutput` includes its
`phase` (`pre-plugin` or `post-plugin`) and separate `stdout` and `stderr`
diagnostics. Each stream reports `receivedBytes`, `lastOutputAgeMs` (`null` when
silent), and a redacted `excerpt` capped at 256 UTF-8 bytes. The failed phase's
ledger detail and stderr retain the same excerpts before exit. Capture is limited
to 64 KiB per stream; exceeding that cap replaces the text with
`omitted: "capture-limit"`. An incomplete private key or a redaction error also
omits the stream text. A recent output age indicates output receipt; it does not
prove that a migration advanced. Output and heartbeats do not extend the phase
deadline. These diagnostics do not establish that every descendant has stopped,
and must not be used as rollback authorization.

Shared CLI disposers have individual five-second deadlines. Failure diagnostics
and any interactive recovery finish before the ten-second exit grace starts.
If the finalizer remains alive after that grace, stderr and the ledger record
active resource types and unsettled disposer names, then the process exits with
its recorded outcome. A retained handle cannot withhold the supervisor's result
indefinitely.
Both stall diagnostics also include `childProcesses`: up to eight descendant
processes with `pid`, `parentPid`, and an executable name (`command`). Arguments,
environment values, and executable paths are omitted. `childProcessesTruncated`
indicates omitted entries; `childProcessInspection: "unavailable"` means the
process list could not be read. A null `command` means that process's executable
name was unavailable. Inspection runs only after a stall and adds at
most one second to the exit bound. Phase-failure JSON includes the same fields.
Preserve these diagnostics and the phase receipts when reporting a blocked child.
Completion-cache refresh remains best effort when its child can be stopped within
the phase budget. A phase that exceeds its overall deadline still fails finalization.

Plugin artifacts that require capability consent are not installed without an
interactive review or explicit `--accept-capabilities`. `--yes` alone does not
accept capability changes, and JSON mode does not prompt. An unresolved review
preserves the previous plugin payload and appears in `postUpdate.plugins.warnings`
with a `PLUGIN_CAPABILITY_CONSENT_REQUIRED` outcome. When required checks pass,
`openclaw update` can complete the core update and requested Gateway restart with
`status: "ok"`; `update repair` reports `status: "warning"` without requesting
update activation. Both commands exit successfully. This also applies when a
bundled plugin moves to an external package or a missing configured plugin has
no install record yet; the unreviewed replacement is not installed. Automatic repair can
report a deferred replacement as a notice when a usable, enabled artifact remains
installed; that retained artifact still undergoes payload validation.

If the core package has already changed, run `openclaw update repair` in an
interactive terminal to review plugin capabilities. After reviewing the changes,
automation can use `openclaw update repair --accept-capabilities`. Acceptance
applies to each artifact's recomputed declared surface during this invocation;
it does not approve future capability additions.

### Skipped legacy audit recovery

In native `auto` mode on Linux, fs-safe handles legacy audit moves on filesystems
that reject no-replace rename by publishing an exclusive hard link, then removing
the old name. Doctor retains its separate compatibility publisher when the native
helper is missing or disabled. Native `require` mode refuses unsupported moves.
This preserves the original inode, including later appends from an older CLI's
open file descriptor. Existing destinations are never overwritten. Doctor
recovers interrupted link pairs before importing; backups capture one sanitized
copy without changing either live name.

If the filesystem also rejects hard links, Doctor preserves the audit files and
reports a recoverable warning with the affected filename and a command targeting
that state directory. Other repairs and update finalization continue. Restore
hard-link support, or stop the Gateway and all CLI writers before moving the
complete state directory to a compatible filesystem, then run the reported `openclaw doctor --fix`
command. If the directory moved, update `OPENCLAW_STATE_DIR` in that command.
Doctor never substitutes a file copy: doing so could lose later audit appends.

When a legacy audit raw archive changed other than by append, Doctor preserves it
beside itself with a `.quarantined-<date>-<id>` suffix. The warning names the
quarantined path and explains the expected append-only growth and observed change.
An empty raw archive without a checkpoint is also quarantined when its sanitized
companion still contains history. Doctor keeps the sanitized records and existing
SQLite rows, continues later repairs, and does not repeat the warning on subsequent
runs. Quarantine does not import the changed bytes or delete the archive or backups.
Quarantined raw archives remain local and are excluded from portable backups;
sanitized companions and retained SQLite audit history are backed up normally.

Doctor can leave other legacy audit sources in place when a raw archive has no
checkpoint and begins with ambiguous whitespace, or cannot obtain another durable
raw-archive checkpoint. These conditions produce
a `skipped` migration receipt with a warning. Other repairs continue, and update
finalization can complete with warnings. An unsafe recovery failure, such as an
interrupted archive that cannot be restored, still stops Doctor.

Preserve the reported source, its sanitized companion (for example,
`logs/config-audit.jsonl.migrated` beside `logs/config-audit.jsonl.migrated.raw`),
and any recovery journals or backups. Follow [backup guidance](/install/backups)
before attempting recovery, and include the warning and archive filenames when
requesting help. Do not delete or rewrite archives or checkpoints to suppress
the warning.

Warnings for sources left in place repeat on later Doctor or `openclaw update repair`
runs until the archive is resolved. Successful finalization does not mean this historical audit
data was imported. There is currently no supported sanitized-only import when
the raw archive is unusable: accepting the companion as a recovery source needs
an explicit reconciliation procedure that preserves duplicate events, retained
history, and checkpoint evidence.

## `update cleanup`

Retire migration recovery originals after you have verified that the upgrade and
session history work. Start with a preview, which can run while the Gateway is
active:

```bash
openclaw update cleanup --dry-run
openclaw --profile work update cleanup --dry-run --json
```

Cleanup targets the selected profile and `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH`
overrides. It displays that state directory and does not redirect to a managed
service. Confirm the displayed directory is the installation you intend to clean.
`--dry-run` reads configuration and recovery metadata, including existing update
history for startup-migration backups, without taking a maintenance lock, loading
plugins, or creating state.
Candidate bytes still require identity verification; historical artifacts are
listed separately as requiring verification. Protected and blocked artifacts
include reason codes.

Before applying, stop the Gateway for that same profile/state directory and wait
for other SQLite maintenance commands to finish. Stop database readers too,
including watchers that repeatedly run `openclaw sessions --all-agents --json`,
and keep them stopped until cleanup exits. Read-only SQLite connections can
create or change WAL/SHM sidecars, invalidating cleanup's destination check even
when session content is unchanged. If cleanup reports `Recovery destination
database changed; preview cleanup again.`, stop those readers, preview again,
and retry. Cleanup requires exclusive offline state ownership and never stops
or restarts a service itself.

<Warning>
Cleanup permanently removes the selected rollback originals, including branches
and metadata intentionally removed by a verified repair. Doctor restore cannot
recreate them afterward. Keep them, or preserve an independent backup containing
them, if you still need that rollback path. Current SQLite history stays in place.
</Warning>

```bash
openclaw update cleanup
openclaw update cleanup --yes --json
```

Interactive confirmation defaults to **No**. JSON mode never prompts or grants
consent; unattended deletion requires `--yes`. Consent does not override
ownership, file identity, or dependency checks. Applicable flags (`--dry-run`,
`--yes`, and `--json`) work before or after `cleanup`; update-only flags
`--channel`, `--tag`, `--timeout`, `--no-restart`, and `--accept-capabilities`
are rejected.

Only owner-recorded recovery artifacts with complete import evidence are
eligible. Unknown or unimported history, malformed inputs, trajectories,
forensic corrupt databases, operator backups, and unmanifested artifacts stay
protected. Old manifests are verified offline where possible; missing evidence
is a reason to retain an artifact. Cleanup has no automatic expiration policy.
Doctor's `<database>.pre-startup-migration-<id>.bak` groups become eligible only
after Doctor verifies migration completion and update history records a successful
update that started later. Until then they appear as protected. Changed or
unrecorded backups remain protected or blocked; cleanup never infers permission
to delete from their filenames. Keep these files with your pre-upgrade backups
while you still need to restore the matching database generation.
Private package, command-shim, and Git runtime backups remain owned by the update
transaction and are outside this migration cleanup. An interrupted entry in update
history does not block cleanup of otherwise eligible migration archives.

The JSON result contains `stateDir`, `status`, `artifacts`, and `totals`. Each
artifact reports its path, run ids, logical bytes, outcome, and reason. Totals
separate candidates, verification-required, protected, blocked, and removed
bytes. Removal failures exit nonzero. Keep the recovery manifests and rerun
cleanup to finish recorded interrupted work; a retry does not delete a recreated
file. Removed logical bytes do not promise
equivalent physical space reclamation on cloned or snapshotted filesystems.
When a path cannot be inspected, its logical size comes from recorded artifact
metadata when available. Cleanup records durable intent before removal and uses
exclusive no-copy publication. Failures are reported; retries reconcile file
operations that already completed. Manifest files are synchronized before removal;
parent directories are synchronized where supported. Windows does not provide the
same parent-directory durability guarantee.

Doctor restore reports intentionally disposed originals and pending cleanup
explicitly. Neither update nor cleanup creates an automatic full-state backup;
these recovery originals are **not a full pre-upgrade backup**. See
[Before updating: create a verified backup](/install/updating#before-updating-create-a-verified-backup)
for backup coverage and [Doctor recovery](/cli/doctor#session-sqlite-migration)
for restoring retained originals.
