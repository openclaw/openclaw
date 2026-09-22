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

## Plugin repair warnings

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

## Reason codes

- `dirty`, `no-upstream`: repair the source checkout before retrying.
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
