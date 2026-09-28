---
doc-schema-version: 1
summary: "CLI reference for `openclaw update` (updates, repair, and recovery cleanup)"
read_when:
  - You want to update a source checkout safely
  - You are debugging `openclaw update` output or options
  - You want to inspect or retire migration recovery originals after an update
  - You need to understand `--update` shorthand behavior
title: "Update"
---

# `openclaw update`

Update OpenClaw and switch between stable/extended-stable/beta/dev channels.

If you installed via **npm/pnpm/bun** (global install, no git metadata),
updates go through the package-manager flow described in
[Updating](/install/updating).

Custom npm prefixes such as `~/.npm-global` are recognized from npm's configured
prefix and the installed OpenClaw launcher. A prefix configured in `~/.npmrc`
does not need a matching `NPM_CONFIG_PREFIX` environment variable. If no owner
can be identified, the CLI includes the inspected package, prefix, and launcher
paths and the package-manager probe results in its guidance.
Installation inspection also reports the root, Git metadata, `node_modules`
layout, and service unit target (or why it was not inspected). An unrecognized
root skips target preflight and gives commands to locate the owning installation.

An older updater that stops before staging cannot use this repair. For a known
npm installation, supply its configured prefix explicitly for that update:
`NPM_CONFIG_PREFIX="$(npm prefix -g)" openclaw update`.

An installation without a detected package-manager owner records a **skipped**
update, exits successfully, and leaves the Gateway running. For Docker/container
images, pull or build the new image and recreate the container with the same
state/config mounts. For a standalone or extracted tarball installation, reinstall
using the original method; Yarn global installations must be updated with Yarn.
The CLI displays this next action. Existing profiles also record it in update
history and include it in JSON as `run.origin.nextAction`. With `--json`, a fresh
profile emits the guidance to stderr and does not create a state database for a
skipped update. These non-outcomes do not run rollback verification or offer an
update failure report.

## Usage

```bash
openclaw update
openclaw update status
openclaw update repair
openclaw update cleanup --dry-run
openclaw update wizard
openclaw update --channel extended-stable
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --dry-run
openclaw update --no-restart
openclaw update --yes
openclaw update --accept-capabilities
openclaw update --json
openclaw --update
```

`openclaw --update` rewrites to `openclaw update` (useful for shells and
launcher scripts).

Invalid configuration reports `invalid-config` before database schema inspection.
An unreadable configuration file or failed configuration loading step instead
reports `config-read-failed`, with a recognized filesystem error code when available.
For supported package targets, the candidate makes that
decision after private staging; see [Candidate-owned admission](#candidate-owned-admission).
The local diagnostic identifies invalid fields and recommends
`openclaw doctor --fix`, followed by correcting any remaining errors. A dry run
keeps this guidance in its JSON `notes` without changing the configuration.
Public failure reports retain the rejected schema area, such as `gateway.*`,
while hiding operator-defined keys and rejected values. Admission still runs
when the selected package version matches the installed version; the no-op
decision follows validation of the selected artifact and live installation.
Guided recovery recognizes the saved config failure after a later successful
update and still verifies the installed runtime and Gateway readiness.

The 2026.9.4 updater reports this condition as `database-schema-preflight` and
can show `mode: unknown` even after resolving an npm target. Before another
update or dry run replaces the latest history, run `openclaw update status --json`
and inspect `lastRun.origin.nextAction` and `lastRun.target` for the recorded
reason and target. A candidate release cannot repair an installed updater that
refuses before staging it; correct the configuration before retrying.

Updaters without the admission fix first shipped in 2026.7.2-beta.5 (including 2026.6.34–2026.6.35 and the 2026.7.33–2026.7.35 extended-stable line) also refuse before staging with `plugins.load.paths: plugin path not found`; restore a missing custom plugin directory or remove its configured path before retrying. `openclaw doctor --fix` can repair recognized bundled-path aliases and preserves unrelated custom paths.

Update admission recognizes orphan `task_delivery_state` rows whose parent tasks
are missing as repairable. When it can acquire Doctor's ownership fences, it runs
the same [preservation-first recovery](/reference/database-schemas/integrity-and-recovery#doctor-reports-orphan-task-delivery-rows)
before creating update history. Recovery and its ledger entry commit together;
the entry records the row count and recovery directory. A live Gateway owner,
read-only store, or failed preservation prevents repair and reports
`openclaw doctor --fix` as the next action. Other foreign-key violations and
structural damage still refuse admission.
`--dry-run` reports the repairable condition without recovering rows or creating
an update ledger entry for that refused preview.

The installed 2026.9.4 updater cannot use this recovery before updating itself.
If it refuses with a database integrity error, install the corrective release
manually and run `openclaw doctor --fix`.

Failed update and repair attempts enter [recovery triage](/cli/update#recover-a-failed-update)
after service recovery and cleanup finish. Preflight and finalization join admitted
command cleanup before handing off ownership or reporting completion. If cleanup
cannot confirm that work stopped, the updater retains any acquired ownership and
recovery artifacts and skips automatic service compensation and repair. Inspect
`openclaw update status` and resolve the pending execution before retrying.
A verified rollback does not automatically start triage: the previous generation
is running again, and the report keeps the failing check as the reason.
An interactive update offers the diagnose/report menu with **Exit** selected by
default. Declining or cancelling preserves the failed update's nonzero exit
status. JSON, non-interactive, `--yes`, and managed-service handoff invocations do
not prompt after rollback.

Update completion prints the terminal outcome and a local Markdown report path before exiting, including unexpected failures. Failed runs keep rollback-facing diagnostic JSON within the released 8 KiB limit. That file links a separate artifact containing every individually bounded Doctor finding; the Markdown report also retains the complete inventory. JSON output includes `reportPath`; a report-write failure prints a warning and preserves the update outcome.

After a final interactive update failure, **Diagnose update failure** and
**Report update failure** are separate choices. Reporting first shows the exact
sanitized issue body and defaults confirmation to **No**. After confirmation,
OpenClaw checks the GitHub CLI's active `github.com` account with a silent,
read-only request before issue creation. Fallback and pending outcomes retain the
sanitized report locally; a confirmed issue keeps only its durable issue URL.
If the CLI is missing, authentication is unavailable, or GitHub rejects the
upload, OpenClaw keeps the sanitized report locally and returns to the previous
action menu. Fix the problem, then choose **Report update failure** and confirm
again to retry the same report, or choose **Report in browser** to review and
submit it with your browser's GitHub account. The browser choice is available
when the prepared report fits a prefilled link and no uncertain upload is pending;
it does not require the GitHub CLI. Completed update and Doctor checks are not
rerun. Preparation or submission errors also return to the menu. An uncertain
upload stays pending: **Check report status** looks for the existing issue without
creating another one, and no browser handoff is offered.
Successful submission, explicit exit, and cancellation retain their normal
behavior; Diagnose runs only when selected explicitly.
In the Control UI, an interrupted
pre-create preparation becomes retryable after its local reservation expires.
After an uncertain creation result, OpenClaw checks for an issue matching the
exact report. If neither a verified issue URL nor a definitive rejection is
available, the report stays pending with no replay link because an issue may
already exist.
`--yes`, `--json`, non-interactive runs, and managed-service handoffs never
submit a report.

For admitted updates, unexpected exceptions retain a bounded, redacted error identity and source location
in update history, along with the operation reached and the installation and target
facts resolved so far. Failure reports include the initiating action and the owner's
recorded rollback outcome. Failed steps use stable identifiers such as
`candidate-state-snapshot`, `candidate-doctor-lint`, and `post-install-verify` in
the report body and issue title; command arguments and private paths remain redacted.
A failure during installation or target resolution keeps
that resolution step visible. Older updater processes cannot recover details they
already discarded; a report generated by newer code only includes facts that were
recorded by the updater that handled the failure.

Npm install failures record a recognized error code (or `unknown`) and a sanitized
excerpt of `npm ERR!` / `npm error` lines in update history and the reviewed report.
The existing history format retains at most five lines of 200 UTF-8 bytes each;
permission guidance reserves one of those entries. Home paths, credentials, and
authenticated registry URLs are redacted before the excerpt is recorded.
For `EACCES` or `EPERM`, check `npm prefix -g` and run the update as the installing
account with write access to that prefix. For `ENOSPC`, free space on the prefix
and npm cache volumes. For `E404` or `ETARGET`, check the configured registry and
the requested version or tag. The generated report includes the applicable next
step. An already-running older updater cannot gain this diagnostic capture from
its candidate package.

## Candidate-owned admission

For package-manager updates, `openclaw update` privately stages the selected
package once, then lets that candidate decide whether the live installation can
be updated. Registry targets and explicit artifacts such as `--tag ./openclaw.tgz`
use the same flow. The stage is reused for verification, canary rehearsal, and
activation; a refusal or pre-mutation failure removes it and leaves the installed
package and serving Gateway in place. After admission and package verification,
a matching installed version and artifact build identity remain a no-op unless
the update needs to replace the installation method or a separate serving root.
The temporary candidate is removed without activating it.

When replacement is needed, the updater retains its running worker files before
changing the installed package. Linux OverlayFS installations use private copies
so hard-link copy-up cannot invalidate the retained files’ identity checks.
Other supported filesystems keep the hard-link fast path and copy fallback.

Source updates retain a retired workspace dependency link when only its ignored `node_modules` directory remains.
An older installed updater that fails at `updater-runtime-retention` needs this correction in its running code before retrying; a newer candidate cannot repair that earlier step.

The installed updater reads the candidate's `package.json` before running its
pending lifecycle scripts. `openclaw.updateAdmissionProtocol: 1` advertises the
internal admission command. Reading this marker does not execute candidate code.
Managed-service preflight still runs in the installed updater before the
candidate admission process starts.

| Owner                                | Checks and operations                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate-owned (via `update admit`) | Config read/validation with the candidate schema (missing-path style problems that candidate Doctor preserves/handles are `admit` + warning), database schema preflight against the explicit installation root, plugin availability preflight. The Node engine comparison is informational (`ok` or `warn`) and cannot refuse admission. |
| Installed-owned (unchanged)          | Run admission/ledger, executor lease, managed-service preflight (ownership/ancestry), Node runtime selection/provisioning, directory permissions, npm/pnpm lifecycle policy, staging/verify/canary/swap/post-core.                                                                                                                       |

The candidate inspects the live installation read-only, using the same selected
profile, state directory, configuration path, and environment. It does not
acquire a lease, write history, run Doctor repairs, start a Gateway, or receive
update execution authority. A missing custom `plugins.load.paths` entry can
therefore produce an admission warning while preserving the configured path
and plugin configuration bytes. Admission does not promise to repair that path.

A valid `admit` verdict replaces only the candidate-owned checks it reports.
Installed Node preflight always runs for package updates, including selection or
private provisioning of a compatible runtime after an informational Node warning.
A valid `refuse` verdict reports the candidate's reason and next action through
the usual pre-mutation error and JSON output. History records the checks in a
`candidate-admission` step. The installed updater continues to own the update
after admission, including every mutation.

If the marker is absent or invalid, the updater uses its installed admission
checks and records `update-admission-unsupported-target`. If the candidate times
out, crashes, or returns no valid protocol-1 verdict, it records
`update-admission-fallback` and uses those same installed checks. These warnings
are informational; the installed checks determine whether the update proceeds.

Use `--admission installed` to force the installed checks. The default option is
`--admission auto`; this option has no environment-variable form. `--dry-run` always
uses installed checks and does not stage a package or invoke candidate admission.
Git/source updates keep their existing flow.

`openclaw update admit` is an internal command, hidden from help. The supervisor
passes `--context <absolute-path>` to a private mode-0600 context file; this command
path and required argument select admission child mode. The command emits
one JSON document with `protocol`, `verdict`, `reasons`, `warnings`, and `facts`
containing candidate/installed versions, the candidate's `nodeEngines` requirement
when declared, and named check results. It exits `0`
for admission, `3` for refusal, or `2` for an internal error without a valid
verdict. It rejects inherited update authority variables with exit `2`, allowing
the supervisor to fall back. It does not perform managed-service ancestry checks.
The default admission budget is 120 seconds and follows the canary timeout
budget resolution.

Run JSON includes `run.admission` with `owner: "candidate"` or `"installed"`,
and optional `protocol`, `candidateVersion`, `checks`, and `fallbackReason`.
The ledger stores this metadata in its existing origin JSON;
`run.origin.candidateAdmission` retains the bounded, redacted verdict, including
all recorded reasons and warnings. Older history records can omit admission
metadata.

Admission metadata is diagnostic and can be omitted from history when recovery
receipts use the full history budget.

This handoff works only when the installed updater already supports it. An older
updater that refuses before staging cannot use a newer candidate's judgment;
follow the recovery guidance for that installed release first.

## Automation and SSH

For an authorized update on another host, use the target installation's owning
account and a non-interactive SSH command:

```bash
ssh -T user@gateway-host 'openclaw update --yes' </dev/null
```

Ensure `openclaw` resolves to the intended installation in that account's SSH
environment. Add the existing global `--profile <name>` before `update` when
targeting a named profile.

An active chat session alone does not prevent an explicit update. `--yes` skips
confirmation and optional shell-completion prompts. Without it, ordinary upgrades
can still run with piped input, but an operation requiring confirmation, such as a
downgrade, fails promptly. Failure-report menus and triage consent prompts do not
wait for input when stdin is not a terminal. `--yes` does not grant exec approval
or accept changed plugin capabilities.

An agent updating the Gateway that hosts its own session should use the
`gateway` tool's `update.run` action when available. The SSH recipe is for another
host; verify that the destination is not that same Gateway. Normal execution
approvals and deployment ownership still apply.

## Native service commands during updates

Native service install, restart, and stop commands launched by the updater through
the target CLI retain the original update owner while their child processes settle. A command whose owner exits or
loses its lease cannot start another native mutation or commit its pending config
changes. A new update remains excluded while a registered child or its process
group is still alive.

The target runtime must support this ownership handoff. Candidate validation checks
that support before stopping the Gateway or activating its replacement. A missing
target CLI or an older target without support is refused; the updater does not
invoke the old runtime installer as a substitute. Authorized installation-root
changes bind the destination CLI separately while retaining the original update owner. Update-owned commands also refuse unmanaged
restart/stop and detached restart or Windows Startup-folder fallbacks that cannot
retain this ownership. Ordinary user-invoked `openclaw gateway` commands keep their
existing behavior.

On Windows, capability probes stay alive until the updater finishes binding their
process identity. If Windows cannot supply a process creation timestamp, the
updater retains the identity established by the live parent or uses the child's
recorded launcher identity, with a warning in the run history and diagnostic logs.
A different observed identity still refuses the
handoff. Scheduled Tasks using `InteractiveToken` remain supported; this does not
require storing a task password.

This target-CLI protection does not cover every Doctor or plugin child or the
in-process service preparation before package mutation.

## Options

Post-core repair Doctor and `openclaw update finalize` run without a separate
per-Doctor deadline unless the operator supplies `--timeout`. A fresh post-core
process receives the operator choice separately from its internal step allowance.
Older targets retain their existing allowance and deadline behavior.

When `--timeout` is omitted, current CLI and RPC finalization do not add an aggregate
activation deadline. Explicit operator limits and inherited activation allowances
still apply; older or unrecognized handoffs retain their existing finite-deadline
behavior. Probes, ownership admission, readiness, recovery, and cleanup retain
their own bounds. An explicit `--timeout <seconds>` limits each finalization phase
and its child commands. Admission and config phases scale with shared SQLite state.

Post-plugin config validation and readiness checks use the measured shared and
agent database sizes after Doctor finishes, including WAL files. Post-core plugin
installation and update work have no default deadline when `--timeout` is omitted;
explicit operator limits and older caller allowances still apply. When an aggregate
activation budget is present, it uses the measured database sizes, observed candidate startup, plugin
count, and the caller's step allowance. Migrated finalization preserves explicit or
inherited allowances. Aggregate expiry reports `update-activation-timeout` and
retains ownership until writers settle; it does not authorize rollback or restart.
Use `openclaw update status` and Doctor for recovery guidance.

| Flag                                             | Description                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-restart`                                   | Skip restarting the Gateway service after a successful update. Package-manager updates that do restart verify the restarted service reports the expected version before the command succeeds.                                                                                                                                                 |
| `--channel <stable\|extended-stable\|beta\|dev>` | Set the update channel and persist it after core update success. Extended-stable is package-only.                                                                                                                                                                                                                                             |
| `--tag <dist-tag\|version\|spec>`                | Override the package target for this update only. It cannot be combined with an effective `extended-stable` channel, whose verified exact target is mandatory. Package installs reject the `main` shorthand; use `--channel dev` for the supported checkout and build flow. Other explicit package specs keep their package-manager behavior. |
| `--dry-run`                                      | Preview planned actions (channel/tag/target/restart flow) without writing config, installing, syncing plugins, or restarting.                                                                                                                                                                                                                 |
| `--admission <auto\|installed>`                  | Choose candidate admission when supported (`auto`, the default), or force installed admission checks. This option has no environment-variable form. Dry runs always use installed checks.                                                                                                                                                     |
| `--json`                                         | Print machine-readable `UpdateRunResult` JSON. Includes `postUpdate.plugins.warnings` when a managed plugin needs repair, beta-channel plugin fallback details, and `postUpdate.plugins.integrityDrifts` when npm plugin artifact drift is detected during post-update sync.                                                                  |
| `--timeout <seconds>`                            | Optional per-step deadline in seconds. Omit to let package installation, deferred lifecycle scripts, and candidate Doctor finish without a work deadline. Probes and recovery retain their own bounds.                                                                                                                                        |
| `--yes`                                          | Skip confirmation prompts (for example downgrade confirmation).                                                                                                                                                                                                                                                                               |
| `--reapply-local-overrides`                      | Replay trusted local packaged `dist` edits when the new package has the same baseline. Otherwise preserve them for manual recovery.                                                                                                                                                                                                           |
| `--accept-capabilities`                          | Accept each plugin's reviewed capability changes during post-update sync. This acknowledges the exact staged capability surface; it does not disable capability checks or establish future trust.                                                                                                                                             |

There is no `--verbose` flag. Use `--dry-run` to preview planned actions,
`--json` for machine-readable results, and `openclaw update status --json`
for channel, availability, and the latest durable update report. Gateway console verbosity (`--verbose`) and
file log level (`logging.level: "debug"`/`"trace"`) are independent knobs; see
[Gateway logging](/gateway/logging).

Interactive updates show phase transitions, the current step, and elapsed time.
The phases match the Control UI: requested, staging, validating, activating,
restarting, verifying, and finished. When output is piped or captured in a log,
progress prints without animation and reports elapsed time every 30 seconds while
a step is running. Updates, verification, and rollback do not
require inference or model authentication. Model-auth findings remain warnings.
Automatic inference repair belongs to triage after an update has finished with
a failed outcome and released its update ownership; it does not change that
recorded outcome. Reports from older updaters can still contain a `repairing` phase.
Failed steps include the final diagnostics from both output streams; timeouts
are labeled explicitly. The final report includes the outcome, recorded phase durations, failed steps,
verification facts, and recovery guidance. `--json` keeps stdout machine-readable and does not
print progress steps.

When no update is active, `openclaw update status` labels the saved outcome
`Last recorded update` with the recorded start time, so historical results are
distinct from current update activity.

When switching from a dev checkout to a package, the updater replaces npm's
install link and leaves the external checkout untouched. If activation fails,
restoring that link and its launchers does not verify the mutable checkout's
runtime. Recovery stays unverified and does not authorize an automatic restart;
inspect the checkout and recovery report before restarting it.

For a profile without a runtime database, an older npm target initializes its
compatible state before the updater records history. The selected release's
Doctor runs before activation, including when npm's install hooks already created
the database. Existing databases retain their downgrade protections.

If database schema preflight cannot inspect the configured paths because the
config is invalid, its refusal lists the config file and invalid fields. Run
`openclaw doctor --fix` to repair retired or unrecognized fields, correct any
remaining errors, and retry the update. Preflight leaves the config unchanged.

Explicit package specs on a fresh profile first stage with a temporary OpenClaw
profile. The updater inspects the staged runtime's declared schema and Node
requirements before admitting changes to the selected profile. Artifacts without
declared schema support are refused without creating the profile's runtime database.
Preparation uses the original package spec and owning package manager.

A fresh-profile `--dry-run` leaves the database absent and does not record a run.
For package targets, it checks the exact target's Node requirements using the same
runtime planner as a real update. Text output and JSON `notes` report `Would refuse
update` when no usable runtime is available, or `Would replace` when the updater can
refresh its owned managed service to a compatible Node. The preview still exits
successfully and does not install a package or change the service.
If package metadata cannot be resolved, retry with an exact published `--tag`;
failed target selection does not initialize the profile with the updater's schema.
Metadata failures retain the detected update mode and a specific failure fact for
registry lookup, dist-tag resolution, version mismatch, schema declarations, or
Git target inspection. The summary and `openclaw update status --json` include
the reason and next step; the bounded failure report includes the same public
description without publishing local paths or registry response text. Existing
updaters cannot gain these diagnostics until the candidate has been installed.

`--dry-run --json` reports the known installed version in `currentVersion` for
package and Git installs, including a saved dev channel that selects conversion
to Git. If the target version is unresolved, `targetVersion` remains `null` and
the additive `targetVersionReason` field explains why. Resolved targets omit this
field. The text preview also shows the installed version and explains unresolved
targets.

`--yes` also skips the optional shell-completion setup prompt. Existing
completion profiles and caches are still repaired when needed; installing
completion in a new shell profile remains an interactive choice.

`--tag` changes only this package update. A saved `update.channel` continues to
govern later foreground and automatic updates, even after a one-off beta
install. Use `--channel` to change that policy.

For explicit package artifacts, configured plugin availability is checked against the privately staged package version before rehearsal or activation. `--dry-run` does not stage the artifact and reports that this check remains pending.

Managed update handoffs preserve the selected artifact, including already-current
repeats, so target checks use that artifact's database schema and runtime requirements.

For source checkouts, `--dry-run` previews the update flow without fetching Git
refs or checking working-tree changes. The real update checks for uncommitted
changes before modifying the checkout. Use `openclaw update status` to inspect
the current branch, version, and update availability.

<Note>
In Nix mode (`OPENCLAW_NIX_MODE=1`), mutating `openclaw update` runs are disabled. Update the Nix source or flake input for this install instead; for nix-openclaw, use the agent-first [Quick Start](https://github.com/openclaw/nix-openclaw#quick-start). `openclaw update status` remains read-only. `openclaw update --dry-run` previews the flow without changing the installation. It records a skipped run only when the profile already has a runtime database.
</Note>

<Warning>
Downgrades require confirmation because older versions can break configuration.
If the install has already migrated sessions to SQLite, restore archived legacy
transcript artifacts before starting an older file-backed version. See
[Doctor: Downgrading after session SQLite migration](/cli/doctor#downgrading-after-session-sqlite-migration).
</Warning>

## `update wizard`

Interactive flow to pick an update channel and confirm whether to restart the
Gateway afterward (defaults to restart). Selecting `dev` without a git
checkout offers to create one.

The channel picker reads the local install identity without checking Git
freshness or dependencies. Those checks run when you apply the update; use
`openclaw update status` to inspect availability first.

| Flag                    | Default | Description                                                  |
| ----------------------- | ------- | ------------------------------------------------------------ |
| `--timeout <seconds>`   | Unset   | Optional deadline for each update step in seconds.           |
| `--accept-capabilities` | `false` | Accept reviewed plugin capability changes during the update. |

## Detailed topics

<CardGroup cols={3}>
  <Card title="Status and run history" href="/cli/update/status-and-history" icon="list">
    `update status`, the durable run ledger, and the reports each run writes.
  </Card>
  <Card title="Repair and recovery" href="/cli/update/repair-and-recovery" icon="wrench">
    Triage after a failed update, `update repair`, and `update cleanup`.
  </Card>
  <Card title="How an update runs" href="/cli/update/how-updates-run" icon="gear">
    Channel switching, validation, restart handoff, and the Git checkout flow.
  </Card>
</CardGroup>

- <a id="recover-a-failed-update"></a>[Recover a failed update](/cli/update/repair-and-recovery#recover-a-failed-update)
- <a id="update-status"></a>[`update status`](/cli/update/status-and-history#update-status)
- <a id="run-history-and-reports"></a>[Run history and reports](/cli/update/status-and-history#run-history-and-reports)
- <a id="update-repair"></a>[`update repair`](/cli/update/repair-and-recovery#update-repair)
- <a id="update-cleanup"></a>[`update cleanup`](/cli/update/repair-and-recovery#update-cleanup)
- <a id="what-it-does"></a>[What it does](/cli/update/how-updates-run#what-it-does)
- <a id="validation-and-activation"></a>[Validation and activation](/cli/update/how-updates-run#validation-and-activation)
- <a id="durable-serving-recovery"></a>[Recovery limits](/cli/update/how-updates-run#durable-serving-recovery)
- <a id="legacy-package-rollback"></a>[Compatibility-checked package rollback](/cli/update/how-updates-run#legacy-package-rollback)
- <a id="restart-handoff"></a>[Restart handoff](/cli/update/how-updates-run#restart-handoff)
- <a id="control-plane-response-shape"></a>[Control-plane response shape](/cli/update/how-updates-run#control-plane-response-shape)
- <a id="git-checkout-flow"></a>[Git checkout flow](/cli/update/how-updates-run#git-checkout-flow)
- <a id="channel-selection"></a>[Channel selection](/cli/update/how-updates-run#channel-selection)
- <a id="update-steps"></a>[Update steps](/cli/update/how-updates-run#update-steps)
  - <a id="verify-clean-worktree"></a>[Verify clean worktree](/cli/update/how-updates-run#verify-clean-worktree)
  - <a id="resolve-the-target"></a>[Resolve the target](/cli/update/how-updates-run#resolve-the-target)
  - <a id="build-a-candidate"></a>[Build a candidate](/cli/update/how-updates-run#build-a-candidate)
  - <a id="validate-the-candidate"></a>[Validate the candidate](/cli/update/how-updates-run#validate-the-candidate)
  - <a id="activate-and-verify"></a>[Activate and verify](/cli/update/how-updates-run#activate-and-verify)
  - <a id="sync-plugins"></a>[Sync plugins](/cli/update/how-updates-run#sync-plugins)
- <a id="plugin-sync-details"></a>[Plugin sync details](/cli/update/how-updates-run#plugin-sync-details)

## Related

- `openclaw doctor` (offers to run update first on git checkouts)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
