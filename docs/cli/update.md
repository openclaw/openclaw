---
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

Failed update and repair attempts enter [recovery triage](/cli/update#recover-a-failed-update)
after service recovery and cleanup finish.
A verified rollback does not start triage: the previous generation is running
again, and the report keeps the failing check as the reason.

After a final interactive update failure, **Diagnose update failure** and
**Report update failure** are separate choices. Reporting first shows the exact
sanitized issue body and defaults confirmation to **No**. After confirmation,
OpenClaw checks the GitHub CLI's active `github.com` account with a silent,
read-only request before issue creation. Fallback and pending outcomes retain the
sanitized report locally; a confirmed issue keeps only its durable issue URL.
If the CLI is missing or that check cannot confirm authentication, OpenClaw
provides a prefilled issue link without starting issue creation. If the exact
report exceeds the browser URL limit, OpenClaw keeps the sanitized body locally
and returns to the action menu, where reporting can be chosen and confirmed
again. A report preparation or submission
error also returns to that menu; Diagnose runs only when selected explicitly.
In the Control UI, an interrupted
pre-create preparation becomes retryable after its local reservation expires.
After an uncertain creation result, OpenClaw checks for an issue matching the
exact report. If neither a verified issue URL nor a definitive rejection is
available, the report stays pending with no replay link because an issue may
already exist.
`--yes`, `--json`, non-interactive runs, and managed-service handoffs never
submit a report.

## Options

Updater-managed `openclaw update finalize` runs repair Doctor without an automatic
wall-clock deadline, including post-plugin repair. It waits for completion,
failure, or manual cancellation. An explicit `--timeout <seconds>` still limits
each finalization phase and its child commands. Post-plugin config validation and
readiness checks keep their separate three-minute defaults; other finalization
phase limits are unchanged.

| Flag                                             | Description                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-restart`                                   | Skip restarting the Gateway service after a successful update. Package-manager updates that do restart verify the restarted service reports the expected version before the command succeeds.                                                                                                                                                 |
| `--channel <stable\|extended-stable\|beta\|dev>` | Set the update channel and persist it after core update success. Extended-stable is package-only.                                                                                                                                                                                                                                             |
| `--tag <dist-tag\|version\|spec>`                | Override the package target for this update only. It cannot be combined with an effective `extended-stable` channel, whose verified exact target is mandatory. Package installs reject the `main` shorthand; use `--channel dev` for the supported checkout and build flow. Other explicit package specs keep their package-manager behavior. |
| `--dry-run`                                      | Preview planned actions (channel/tag/target/restart flow) without writing config, installing, syncing plugins, or restarting.                                                                                                                                                                                                                 |
| `--json`                                         | Print machine-readable `UpdateRunResult` JSON. Includes `postUpdate.plugins.warnings` when a managed plugin needs repair, beta-channel plugin fallback details, and `postUpdate.plugins.integrityDrifts` when npm plugin artifact drift is detected during post-update sync.                                                                  |
| `--timeout <seconds>`                            | Per-step timeout. Default `1800`.                                                                                                                                                                                                                                                                                                             |
| `--yes`                                          | Skip confirmation prompts (for example downgrade confirmation).                                                                                                                                                                                                                                                                               |
| `--accept-capabilities`                          | Accept each plugin's reviewed capability changes during post-update sync. This acknowledges the exact staged capability surface; it does not disable capability checks or establish future trust.                                                                                                                                             |

There is no `--verbose` flag. Use `--dry-run` to preview planned actions,
`--json` for machine-readable results, and `openclaw update status --json`
for channel, availability, and the latest durable update report. Gateway console verbosity (`--verbose`) and
file log level (`logging.level: "debug"`/`"trace"`) are independent knobs; see
[Gateway logging](/gateway/logging).

Interactive updates show phase transitions, the current step, and elapsed time.
The phases match the Control UI: requested, staging, validating, optional
repairing, activating, restarting, verifying, and finished. When output is
piped or captured in a log, progress prints without animation. `repairing` can
follow failed candidate validation or failed post-activation verification when
rollback is unsafe or has failed; successful repair returns to validation or
verification. The Control UI shows this optional phase only after it starts.
Failed steps include the final diagnostics from both output streams; timeouts
are labeled explicitly. The final report includes the outcome, recorded phase durations, failed steps,
verification facts, and recovery guidance. `--json` keeps stdout machine-readable and does not
print progress steps.

When switching from a dev checkout to a package, the updater replaces npm's
install link and leaves the external checkout untouched. If activation fails,
restoring that link and its launchers does not verify the mutable checkout's
runtime. Recovery stays unverified and does not authorize an automatic restart;
inspect the checkout and recovery report before restarting it.

`--yes` also skips the optional shell-completion setup prompt. Existing
completion profiles and caches are still repaired when needed; installing
completion in a new shell profile remains an interactive choice.

`--tag` changes only this package update. A saved `update.channel` continues to
govern later foreground and automatic updates, even after a one-off beta
install. Use `--channel` to change that policy.

For explicit package artifacts, configured plugin availability is checked against the privately staged package version before rehearsal or activation. `--dry-run` does not stage the artifact and reports that this check remains pending.

For source checkouts, `--dry-run` previews the update flow without fetching Git
refs or checking working-tree changes. The real update checks for uncommitted
changes before modifying the checkout. Use `openclaw update status` to inspect
the current branch, version, and update availability.

<Note>
In Nix mode (`OPENCLAW_NIX_MODE=1`), mutating `openclaw update` runs are disabled. Update the Nix source or flake input for this install instead; for nix-openclaw, use the agent-first [Quick Start](https://github.com/openclaw/nix-openclaw#quick-start). `openclaw update status` remains read-only. `openclaw update --dry-run` previews the flow and records a skipped run without changing the installation.
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
| `--timeout <seconds>`   | `1800`  | Timeout for each update step.                                |
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
