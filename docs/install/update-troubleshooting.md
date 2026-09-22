---
summary: "Recover from failed OpenClaw updates in the Control UI or CLI"
read_when:
  - An OpenClaw update failed
  - The Gateway did not report a final update result
title: "Update troubleshooting"
---

Failed updates enter built-in triage after update recovery settles. In an
interactive terminal, OpenClaw shows the selected agent, saved prompt path when
available, and use of your own account/tokens, then asks before launching
[triage](/cli/triage). Only an affirmative Yes proceeds. Enter, `n`, cancellation,
or no answer within 30 seconds skips the launch and preserves diagnostics and
a manual recovery command. Use `openclaw triage --agent codex` to choose another
agent. With `--yes`, `--json`, or no interactive terminal, eligible failures can
start one owned automatic repair; other failures retain diagnostics and handoff
commands. See [automatic recovery](/cli/triage#automatic-failure-handoff). The original update failure and exit status remain authoritative;
diagnostics do not turn a failed update into a successful one.

If the update health check emits a complete lint report but does not exit before
its deadline, the failure identifies that completion separately from process
termination. An exited child whose output pipes remain open is reported
separately. Without a complete lint report, a deadline does not establish that
the checks finished. When automatic repair cannot find a usable inference route
before starting a repair turn, it is recorded as skipped; the original update
check remains the reported failure.

In the Control UI, a failed attempt opens **Ask OpenClaw** with its recorded
details and asks it to investigate before retrying. A lost connection or
verification timeout is presented as an unknown outcome. The tab remembers the
latest 32 investigated attempt identities, scoped to their Gateway and profile.
Status checks, switching between those scopes, and reloading the same tab do not
automatically send those investigations again. If the browser cannot read or
save that history, the failure details remain visible without an automatic
diagnostic request. Ask OpenClaw manually or run `openclaw triage` on the host.
If the Gateway or agent is
unavailable, use `openclaw triage` on the Gateway host. Automatic diagnosis keeps
your unsent composer draft, including when its conversation session must restart.

**Control UI → Settings → Updates** keeps the latest recorded attempt visible,
including its time, before/after identities, reason code, failing step, and
bounded diagnostic detail. A version or revision verification failure stays
visible when a status check rereads the same attempt. An unknown verification
outcome resolves when the expected version or revision arrives, or when the
same attempt reports its final failure or cancellation. A newer recorded attempt
can also replace it. Intentional cancellations, already-current installs, and
updates still in progress do not start triage.

For a final failed attempt, **Report update failure** is separate from **Retry**
and **Ask OpenClaw**. It previews a bounded report containing the OpenClaw
version, platform, update target, failed phase, sanitized diagnostics, and
verified rollback outcome. The report excludes secrets, tokens, chat content,
raw logs, private absolute paths, and recovery commands. Nothing is submitted
until an administrator confirms that preview. OpenClaw then uses the existing
GitHub CLI issue flow. Fallback and pending outcomes retain the sanitized report
locally; a confirmed issue keeps only its durable issue URL. OpenClaw first makes
a silent, read-only request with the active `github.com` account. A missing CLI
or a failed, unavailable, or timed-out authentication check returns a prefilled
issue link without starting issue creation. In the Control UI, an interrupted
preparation for the recorded attempt can be retried after its local reservation
expires. Once issue creation starts, a
timeout, signal, nonzero exit, or malformed response without a verified issue
URL leaves the attempt pending without a replay link, because the issue-creation
outcome may be unknown. The action is tied to one update-attempt identity and
cannot submit that attempt twice; reconnecting or refreshing status never
reports it automatically. A CLI reporting error returns to the explicit action
menu and never starts diagnosis on the user's behalf.

Control UI remediation uses typed product actions only. It leads with an
authenticated Gateway or native action when the connected UI has the required
capability and scope, preserves confirmations for disruptive operations, and
keeps terminal commands as secondary host-side fallbacks. It never parses
localized guidance or executes an arbitrary command string.

## Recover in the Control UI

1. Select **Check status** when the Gateway restarted, disconnected, or did not
   report a final result. This reads `update.status`; it does not start another
   update. Recovery controls stay disabled while the check is pending, and a
   rejected request appears as an error on the page or in the update dialog.
   The dialog shows **Checking status…** while waiting and **Status refreshed.**
   after a successful read, even when the recorded failure has not changed.
   If the Gateway is disconnected, reconnect before checking or retrying.
2. Open **View details** and address the recorded failing step. Diagnostic text
   is bounded and redacted for display; use Gateway logs when more context is
   required.
3. Select **Retry update** only after the cause is resolved. The Control UI uses
   the normal confirmed update flow and states that running sessions are
   interrupted while the Gateway restarts.

The controls require a connected Gateway, support for the corresponding typed
Gateway method, and administrator scope. When those conditions are not met, use
the CLI fallback on the Gateway host.

## Doctor cannot enter maintenance during finalization

`finalize:doctor` can report `Doctor could not enter maintenance` when a Gateway
still owns the selected state directory. A starting Gateway and a healthy serving
Gateway retain that ownership for their entire process lifetime; waiting for
readiness does not release the lock.

Maintenance admission refusals finish the update with a recorded warning when
no data is at risk, including contention from an unknown or non-serving holder.
Repair restores a managed service it stopped before reporting that warning.
Doctor and plugin maintenance remain pending. Resolve the reported ownership or
availability problem, then run `openclaw update repair`. Check
`openclaw update status --json` and `openclaw gateway status --deep` for pending
migrations, the recorded warning, and current health.

Do not delete lock files to force entry. A dead process releases the physical lock,
and lease owners reclaim provably dead identities. A maintenance warning never
authorizes concurrent repair or discards recovery backups. Active migration
writes, unreadable state, incomplete migrations, and unconfirmed subprocess
cleanup retain their failure and recovery guidance.

## Node and global install permissions

For `node-runtime-preflight`, upgrade the runtime named in the message to a
version satisfying both the candidate's full engine range and the updater's
supported Node range. The suggested version is the lowest supported release in
that intersection. Follow the recovery steps for the detected runtime manager
(nvm, fnm, Volta, or system Node). The next step runs `update` through the
original installation's absolute `openclaw.mjs` launcher using the selected Node.
It does not rely on `openclaw` remaining on PATH after a version-manager switch,
or recommend a global install into an uninspected prefix. Extended-stable recovery
uses `--channel extended-stable` so the resolver selects the supported monthly
release; other package channels retain the inspected version with `--tag`.
An explicit channel switch is included in recovery because the runtime refusal
happens before that preference is saved. If an already-current service is stopped
or its definition cannot be refreshed, have its deployment owner select the
supported Node in that definition before retrying. Switching the shell runtime
does not change a service's pinned Node path.

Keep the same service account, profile, and state/config overrides. Recovery
restores the recorded service selectors, including overrides absent from your
shell; credentials are not included. The ordinary update invocation rechecks
the selected npm prefix and managed service before installation, and retains
the original package owner. Its normal runtime selection, service refresh,
restart, and verification checks apply. Containers redeploy the target image
with the same state/config mounts.

`global-install-foreign-destination` means the selected prefix is foreign or its
ownership could not be established. An inaccessible prefix, failed npm prefix
probe, or unreadable layout stops the update before staging; an unknown
destination is never treated as empty. Restore inspection access or make
`npm prefix -g` succeed with the selected runtime. Ask the deployment owner to
verify unreadable layouts and explicitly select the intended installation.
The saved outcome and public failure report name the destination prefix, package,
launcher, running installation, and classified ownership cause. Public paths
replace your home with `~` and redact other home-directory usernames. `openclaw
update status` and Doctor retain the warning and recovery step. A symlinked prefix
that resolves to the same installation is admitted; spelling alone does not make
a destination foreign. Switch the runtime back and
retry through the retained absolute launcher. Alternatively, with the destination
owner's agreement, explicitly select that installation for the intended service
using a printed `gateway install --force` command when available, then update. This changes
the service binding; it is not permission to overwrite another deployment's
package. A protected service definition uses deployment-owner instructions instead;
`--force` cannot replace a sealed mount. Dry-run returns the same refusal. Recorded attempts remain in update
history and are shown by Doctor. If the active CLI and service point at different
installations, follow [Gateway service recovery](/cli/doctor/recovery#gateway-service-recovery)
to select the intended installation while preserving its state and service account.
An older updater that refuses before staging cannot load a candidate's improved
diagnostics; resolve its prefix mismatch before retrying the update.

If the ranges do not overlap, install a supported Node and select a compatible
OpenClaw target; that candidate cannot run through this updater on a supported
Node release. See [Node.js](/install/node).

For `global-install-permission-denied`, check the named directory and owner.
If you own the directory, the message gives a scoped `chmod u+rwx` command.
For an administrator-owned npm prefix, have that account perform the package
update or grant the intended updater write access. Keep the Gateway's existing
state and configuration; invoking the whole updater with `sudo` can select a
different home and service account. Do not recursively change ownership of a
shared system prefix. A personal install can instead use a
[user-writable npm prefix](/install/node#permission-errors-on-npm-install-g-linux).

Permission errors discovered after admission carry the same reason. The report's
rollback and service-recovery constraints still apply if activation had begun.
Inside a container, the same next action also directs you to pull or build the
target OpenClaw image and redeploy with the same state/config mounts. Package
changes inside a running container are not durable.

## Published 2026.9.4 on large agent fleets

The published 2026.9.4 updater shares a five-minute deadline across snapshot
preparation and candidate checks. Its failure log tail combines output from
those checks: `Doctor complete.` can belong to the preceding repair pass, even
when lint is the failed step. The elapsed time in the final log line measures
the whole rehearsal; the step duration measures the individual check. A complete
lint JSON report is needed to establish that lint finished before termination.

Published OpenClaw 2026.9.4 can spend many minutes preparing model catalogs and
chat metadata after its HTTP listener binds. In an instrumented 480-agent
control with no update, HTTP probes remained unanswered during 944 seconds of
observation; the Gateway then logged `ready` at 947.5 seconds. Stopping that
instance eventually required systemd's existing 5-minute-30-second stop limit.
These are measurements of one synthetic fixture, not expected startup budgets.

A second, uninstrumented 480-agent control first passed signed Gateway
handshake, serving-build, and health-RPC checks, then lost HTTP responsiveness
without any update. The 25-minute post-readiness control completed; sampled
failures spanned 24 minutes before a final three-minute serving check also
failed. The original PID and installation remained. Shared schema 17, all 481
physical agent databases at schema 19, and config bytes stayed unchanged;
captured state-maintenance leases were empty.

The main thread consumed nearly one CPU core. Logs showed existing scheduled
review attempts, fleet-wide integrity checks, and memory-plugin startup cleanup
errors. This reproduces a published Gateway fleet preparation/background
maintenance availability problem independently of updating. Its exact JavaScript
hot loop remains unprofiled, and the original failed-update run lacked the
live-state evidence needed to exclude an additional state or recovery defect.
A retained package, PID, or `serviceRestartSafe: true` does not establish that
the previous Gateway is serving.
See [the investigation](https://github.com/openclaw/openclaw/issues/151295).

Before recovery, preserve the update report and a
[verified backup](/install/updating/rollback-and-recovery#before-updating-create-a-verified-backup).
Keep the same service account, profile, package manager, and installation prefix.
Have that installation's owner stop the Gateway and other writers before manual
replacement. When the installed updater cannot complete, use the
[manual package-manager procedure](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun)
with an exact target compatible with the retained state, then run the target's
`openclaw doctor --fix` before starting its Gateway. If the retained binary
cannot read the current state, follow
[backup recovery](/install/updating/rollback-and-recovery#downgrade); changing
schema markers or deleting lease rows does not reverse migrations.

Verify the actual serving version/build through an authenticated Gateway RPC
and check `/readyz` before declaring recovery or removing backups. The
plain-start control did not verify these recovery steps or establish that
restarting the same 2026.9.4 fleet resolves the failed-update condition.

## Plugin repair warnings

`post-update-plugins` / `plugin-convergence` with
`post-plugin-doctor-execution-failed` can describe a Doctor child failure after
the package was already installed. Updated convergence records that execution
failure as a warning, retains its exit reason and available plugin diagnostics,
and continues to config validation, readiness checks, and Gateway activation.
`openclaw update status` shows the warning even when the update succeeds. A later
failure report keeps it in a separate **Warnings** section.

A throwing plugin config-repair hook leaves that plugin's input unchanged and
names the plugin in its warning. Repair the plugin, then run
`openclaw doctor --fix` or `openclaw update repair`.
A live or unverified Gateway and explicit state-migration or config-write refusals remain blocking. So does a
Doctor child whose shutdown could not be confirmed: it may still write state.
Preserve the backup and resolve that specific refusal before retrying.

Doctor's configured-plugin repair and payload-verification warnings do not block
Gateway readiness. A tracked plugin whose payload is unavailable is marked
unavailable, and its configuration and pending migration inputs stay preserved.
This includes host-link repair failures during updates.
`openclaw update status --json` lists pending plugin migration warnings, and
Doctor reports the affected plugin and repair command. Run `openclaw update repair`,
then `openclaw doctor --fix` to retry after restoring access to the plugin source.

Missing configured `plugins.load.paths` are availability warnings.
The update continues and the Gateway can become ready with the available plugins.
The update report and Doctor lint identify the unavailable path with
`configured-plugin-path-unavailable`.
Permission, I/O, and other filesystem inspection failures use the distinct
`configured-plugin-path-inspection-failed` warning with the original error code
and message. For permission errors, fix permissions on the reported path, then
run `openclaw doctor --fix`; for other failures, resolve the reported filesystem
problem first. Both warnings preserve uninspected configuration and let the update continue.

A load path can contain several plugins or override a bundled plugin, so discovery
cannot infer which settings belong to its missing payload. Doctor preserves
uninspected plugin settings, channel settings, model selections, and load-path
entries instead of treating them as stale or applying another plugin's repair.
Restore the path or correct its `plugins.load.paths` entry, then run
`openclaw doctor --fix` to resume inspection and repair. Other discovery errors
retain their existing diagnostics.

Official version-bound runtime plugins installed through ClawHub use their
declared ClawHub source for the new core release cohort. The released 2026.9.4
catalog omitted that source for Codex; the correction is on main in
[#148518](https://github.com/openclaw/openclaw/pull/148518).

### Missing temporary plugin captures

An `ENOENT` path containing `openclaw-plugin-build-` can identify a missing
runtime source capture even when the installed plugin files still exist.
Reloading or replacing that plugin reports the unavailable recovery snapshot
as a warning and loads the installed replacement after normal cleanup.
Run `openclaw plugins reload <id>`, or reinstall the plugin if its installed
payload also needs repair. If replacement fails, the missing previous code
cannot be restored; healthy plugins retain their available recovery snapshots.

Older releases can reject enable, uninstall, and reinstall while trying to copy
that same missing capture. Restart the Gateway through its service owner before
retrying, or upgrade the host. See [plugin source lifetime](/plugins/architecture#runtime-instance-and-source-lifetime).

### Large model-catalog temporary directories

Older releases can retain several complete plugin copies inside
`openclaw-model-catalog-*` directories. A scan of only top-level
`openclaw-plugin-build-*` paths misses those nested copies. Current catalog
workers reuse the selected runtime capture for provider discovery and remove
their scratch tree when its owner retires.

Upgrade the host, then run `openclaw doctor` to inspect legacy captures.
`openclaw doctor --fix` removes whole legacy catalog trees only during maintenance
when no other OpenClaw process is running. Do not delete captures based on their
age or absence from open-file or memory-map lists: an idle owner can still need
them. Modern captures use SQLite custody to prove retirement. See
[plugin source lifetime](/plugins/architecture#runtime-instance-and-source-lifetime).

## Reason codes

- `dirty`, `no-upstream`: repair the source checkout before retrying.
- `runtime-artifact-publication`: the affected Gateway is running or cannot be
  verified offline. Inspect `openclaw gateway status --deep`, stop it through its
  service owner, and retry. On macOS, a loaded LaunchAgent can respawn even when
  disabled and temporarily has no PID; `openclaw gateway stop` unloads it.
- `update-ledger-busy`: another process held the state database's write lock
  beyond the update step budget. The command exited successfully without admitting
  a run and left previous history intact. Retry once the Gateway's writes settle.
  The update command's JSON output contains the deferred note;
  `openclaw update status --json` shows the previous recorded run.
  If required finalization after a core update is deferred, its child exits
  nonzero so existing parents cannot mistake it for completed plugin convergence.
  Updated Gateways record the skipped reason and do not restart; retrying the
  update runs finalization again, including when the core is already current.
- `plugin-target-unavailable`: an enabled configured npm plugin has no resolvable
  target for the selected core, or its registry metadata could not be read. The
  refusal identifies the plugin, package target, and registry error before the
  serving Gateway stops or the core package changes. Retry after publication or
  registry recovery, use `openclaw update --tag <older-version>`, or disable the
  affected plugin and retry. If the core version is unknown, select an exact
  registry version. Extended-stable rejects `--tag`; retry later or explicitly
  switch channels. `--dry-run` performs the same availability check.
- `preflight-insufficient-space`: free space on the filesystems containing
  preflight staging (the checkout's `.artifacts` area on POSIX) and the
  package-manager store, then retry. The updater stops on
  confirmed ENOSPC instead of trying older commits; it does not delete shared
  package-manager stores. See [Git checkout flow](/cli/update#git-checkout-flow)
  for staging placement and the older published-updater limitation.
- `deps-install-failed`, `build-failed`, `ui-build-failed`: inspect the failing
  step, fix the dependency or build error, then retry.
- `global-install-failed`: the package-manager install, staging, verification,
  or launcher swap exited nonzero. The updater then attempts rollback. The
  generated report's `Rollback outcome` line and `openclaw update status`
  record whether the previous install was restored and is safe to restart.
  `openclaw gateway status --deep` shows what is serving; confirm both before
  assuming the previous version runs. The generated failure report redacts
  the package manager's own error line; the failing step's bounded stderr tail
  is kept in the durable run record and in the update-failure context saved
  under `logs/support/` in the state directory. Two causes belong to the
  published 2026.9.3 and 2026.9.4 updaters, and a later release cannot rescue
  the updater already installed: on macOS, `Package rollback launcher backup
changed` when the updater's umask differs from the installed launcher's
  permissions, and on busy hosts or slow disks a 30-second baseline package
  fingerprint timeout reported as a changed package tree. Retrying with the
  same installed updater repeats them. Install the target once with the
  [manual package-manager procedure](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun),
  run `openclaw doctor --fix`, and restart the Gateway. This manual install
  bypasses the installed updater once. No published release contains both fixes
  yet: `openclaw update` runs through a repaired updater only after installing a
  release later than 2026.9.4 that contains [#145282](https://github.com/openclaw/openclaw/pull/145282)
  and [#144758](https://github.com/openclaw/openclaw/pull/144758).
  Other causes show the package manager's error:
  `EACCES`, `EPERM`, or a prefix mismatch mean the global prefix is custom or
  not writable by the invoking user; fix ownership and permissions, then retry.
  Re-run the [installer](/install/installer) if the package install is
  incomplete.
- `runtime-verification-failed` near 300 seconds at `candidate gateway canary`
  when updating from 2026.9.4: the installed updater shares that deadline across
  the snapshot and candidate checks, even with a larger `--timeout`. The elapsed
  failure duration is not Gateway startup time alone. Use the same
  [manual package-manager procedure](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun),
  then run `openclaw doctor --fix` and restart the Gateway. See
  [#144858](https://github.com/openclaw/openclaw/issues/144858) and
  [#154381](https://github.com/openclaw/openclaw/issues/154381).
- `doctor-failed`: run `openclaw doctor` on the Gateway host, resolve its
  findings, then retry. See [Doctor](/cli/doctor) for the check list and
  `--fix` behavior.
- `restart-disabled`, `restart-unavailable`: restore a supported supervisor or
  enable Gateway restarts before retrying.
- `restart-unhealthy`, `restart-revision-mismatch`,
  `restart-revision-unavailable`: inspect Gateway service health and its install
  root before retrying.
- `managed-service-handoff-*`: check status first. If the handoff stopped, use
  the CLI on the Gateway host to preserve the full diagnostic output.

Unknown reason codes remain visible. Check the Gateway logs before retrying.

## Retained legacy session history

Invalid entries in a legacy `sessions.json` and malformed JSONL transcripts do
not fail an update when Doctor can verify the imported SQLite state and retain
the originals. Doctor skips entries without a valid session ID and imports the
readable transcript prefix. It reports the file and reason as warnings in its
migration report and in `openclaw update status --json`, including updates started
by older releases that cannot record Doctor warnings themselves.

While a plugin migration is pending, the original files stay in place with a
verified import receipt. Repeated Doctor repairs preserve current SQLite edits
and deletions. After plugin migration finishes, damaged originals remain in the
protected migration archive for manual recovery; update cleanup cannot discard
them as fully imported history.

Preserve the named files and your pre-update backup. Inspect them with
`openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents --json`.
Do not overwrite receipt-bound originals to repair them. Changed or newly
appeared transcripts can contain history absent from SQLite and still block
readiness. Check `openclaw update status --json`, stop the Gateway, and run
`openclaw doctor --session-sqlite recover --session-sqlite-all-agents` before
retrying. See [session recovery](/cli/doctor/sqlite-maintenance).

## CLI fallback

Run these commands on the Gateway host, not on the computer that merely has the
Control UI open:

```bash
openclaw update status --json
openclaw triage
```

Use `openclaw update --dry-run` to preview a new attempt. If a package update
failed after installation began, follow the installer recovery steps in
[Updating](/install/updating#alternative-re-run-the-installer).

If the installed CLI is damaged or the filesystem cannot write diagnostics,
automatic triage reports that failure and preserves the original update error.
Repair the installed command, then run `openclaw triage`. Managed updates retain
their detached helper log even when the Gateway cannot start; the recorded
outcome points to the available diagnostics or the failed collection attempt.
Restart notices summarize the diagnostic outcome. Saved artifact paths and exact,
installation-specific recovery commands remain in the host command output or
managed update helper log rather than the notice sent to an agent or channel.

If the updater crashes or is killed after the Gateway stops, the Gateway stays
stopped unless the updater completed and verified recovery. Inspect
`openclaw gateway status --deep`, repair the reported dependency or installation
failure, and rerun `openclaw update`. A failed Git dependency install restores
and rebuilds the previous runtime before allowing an automatic restart. Restarts
after verified recovery still check the installed configuration, service ownership,
and Gateway health.

## Rollback boundary

Do not restore state as the first response to an update failure. First reinstall
known-good code while preserving current state. Restore a verified pre-update
state snapshot only when older code cannot read the current config or database.
See [Rollback](/install/updating#rollback).

## Support diagnostics

Collect the following without posting credentials, raw config, or unredacted
process output:

- OpenClaw version and install type;
- update timestamp, target, phase, and reason code from Settings → Updates;
- the bounded failure detail shown by **View details**;
- `openclaw update status --json`;
- `openclaw gateway status --deep --json`;
- relevant redacted Gateway log lines.
