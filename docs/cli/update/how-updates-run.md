---
summary: "How `openclaw update` switches channels, validates a candidate, hands off the restart, and updates a Git checkout"
read_when:
  - You want to know what an update does before you run one
  - You are debugging a restart handoff or a control-plane update response
  - You maintain a source checkout and need the Git update and plugin sync steps
title: "How an update runs"
---

Channel switching, candidate validation, the restart handoff, and the Git checkout flow. Part of the [`openclaw update`](/cli/update) reference.

## What it does

Switching channels explicitly (`--channel ...`) also keeps the install method
aligned:

- `dev` -> ensures a git checkout (default `~/openclaw`, or
  `$OPENCLAW_HOME/openclaw` when `OPENCLAW_HOME` is set; override with
  `OPENCLAW_GIT_DIR`), updates it, and installs the global CLI from that
  checkout.
- `stable` -> installs from npm using `latest`.
- `extended-stable` -> resolves the public npm `extended-stable` selector,
  verifies the exact selected package, and installs that exact version. It
  does not fall back to another selector and is rejected for Git checkouts.
- `beta` -> prefers npm dist-tag `beta`, falling back to `latest` when beta is
  missing or older than the current stable release.

### Validation and activation

If the resolved package version equals the installed version without changing
the selected channel or installation method, or the Git target SHA equals
`HEAD`, plugin convergence still runs; if plugins remain unchanged, the run finishes `skipped` with reason `already-current`. A same-version
explicit `--channel` or installation-method change finishes successfully.
Changed plugins restart a running managed Gateway unless `--no-restart` is set; retained exact pins produce the same advisories as a core update without requiring a restart.

For targets that support candidate validation, the old Gateway keeps serving through `staging` and
`validating`. The updater uses the candidate entrypoint for Doctor lint
(`doctor --lint --json --severity-min error`), config validation, and read-only
plugin resolution and compatibility planning. It also rehearses migrations and
boots a canary with copied configuration and verified SQLite snapshots in an
isolated temporary state directory. The copied database registry points to the
copied agent databases. Installed plugin payloads and their dependencies are also
copied; the rehearsal install records point to those copies, and their OpenClaw
host links target the staged candidate. Path aliases that resolve to a running
package's bundled plugin use the staged bundled plugin with the same ID when
available, preserving bundled trust. External path installs keep their existing
classification. The live plugin files and host links stay unchanged. Channels,
cron, automatic updates, and other side services are suppressed in this canary.

Schema checks also use private SQLite copies so inspection does not create or
modify WAL sidecars beside live databases. Each schema inspection has a
30-second deadline; if compatibility cannot be verified, rollback is refused.

The canary binds a free loopback port and must report `/startupz` as `started`,
then `/readyz` as ready within a five-minute total budget. Failure records the
phase, elapsed time, and bounded diagnostics; the canary process group and
temporary state are cleaned up. This proves candidate startup on copied state;
live channel and provider behavior are checked after activation.
Targets that predate migration continuation record runtime validation as
unavailable and use the current updater's existing finalization path. A present
continuation entry with an invalid schema contract still refuses activation.
The database-schema preflight still refuses incompatible downgrades. These older
targets do not support automatic schema-neutral rollback; see
[Downgrade finalization](/install/updating#roll-back-a-package-install).

Candidate Doctor, config, plugin, or canary validation failures enter a bounded
`repairing` phase using configured inference. The updater reruns the failed
check after each attempt and activates only after it passes. Failed or unavailable
repair discards the candidate and leaves the serving Gateway untouched.
Pre-activation repair uses disposable rehearsal state and configuration, then
independently validates surviving candidate changes before activation, and
`repair-requires-config-change` reports changed top-level keys that require
operator-run `openclaw doctor --fix` or `openclaw triage`; post-activation repair
uses the live installation. See
[Unattended repair](/install/updating#unattended-repair-on-your-own-inference) for
budgets, permitted repairs, and attempt reports.

Only `activating` stops the managed service. Its offline work includes the package
or checkout swap, required `doctor --fix` migrations, and state compatibility
inspection, followed by service start
in `restarting`. Update verification does not use model inference. In `verifying`,
the updater checks that the managed service is running and owns its port, requires
the normal 12-probe health settle and a Gateway hello handshake matching the
expected version and Git build identity, checks for plugin activation errors and
channel readiness, and requires HTTP 200 from `/readyz`.

A candidate can be running while verification fails. Recovery guidance uses the
latest observed service state and names the running version when known; an
earlier activation stop does not mean the service remains stopped.

Plugin packages download and sync after the core Gateway is serving. When the
plugin snapshot changes, the updater stops the service for a second measured
activation window, runs the required full Doctor migration pass under exclusive
maintenance, then restarts and verifies the final snapshot. Unchanged plugins
use read-only validation and readiness checks without another full Doctor pass.

The previous package tree remains available until activation or package restoration
is verified. If activation fails before a working package is confirmed and rollback
cannot be verified, finalization retains the backup and reports its location. Keep
that backup and repair the installation before restarting, including for older
targets without migration continuation. Automatic rollback requires that retained package, its pre-update verification, unchanged
config content since the activation Doctor pass, and unchanged pre-existing shared and affected per-agent
SQLite `user_version` values. A database first created during activation or
verification is schema-neutral only at the candidate's supported version for its
database kind; a missing pre-existing database or a new database at a foreign
version blocks rollback. Newly created databases must also be readable by the
previous package; unknown or incompatible support refuses rollback with
`rollback-state-unverified`. The updater restores the previous generation and verifies
it running before finishing `rolled-back`, preserving the failing check as its
reason. See [Automatic rollback](/install/updating#automatic-schema-neutral-rollback)
for the restoration and package-manager guards. The candidate’s own Doctor
migrations in the main config file do not block rollback, including on a fresh
install’s first update. Separate `$include` files must retain their pre-activation
configuration content. Doctor must have consumed the captured pre-update config,
and the current file must match its reported output. Restoration holds the normal config writer lock and
rechecks the captured hash before writing.
When needed, rollback replaces the main config with the exact bytes captured before
Doctor and owner-only permissions (`0600`), including the previous writer stamp.
Operator edits made after activation block
restoration, including edits before Doctor reads the config or after its last write; the next action names the changed config file. A failure alone does not
authorize restarting the candidate.

If the config file changed after the activation Doctor pass or the databases are
not schema-neutral, automatic rollback is refused with
`state-migrated-no-rollback`. The updater enters `repairing` on the installed
candidate, also used if rollback itself fails. If the previous package was
already restored, repair targets that version. Between repair attempts, the
updater starts or restarts a stopped or unhealthy service once and reruns the
post-restart verification checks. Successful verification finishes the run as
`succeeded` for the candidate, or `rolled-back` for the restored release with a
nonzero command exit. Failed repair preserves the original failure and attempt summaries.
Use the recorded diagnostics and [Triage](/cli/triage) for remaining failures,
preserving migrated state. These temporary validation
snapshots are not a full-state backup; see [Rollback](/install/updating#rollback).
If schema state cannot be verified, rollback is refused with
`rollback-state-unverified`; unknown state never counts as schema-neutral.

### Restart handoff

When an agent runs `openclaw update` inside a systemd user service or macOS
LaunchAgent Gateway, the CLI hands the update to the same managed-service helper
before stopping the Gateway. It prints the helper log path and follow-up commands
for update status and Gateway health, then exits; this acknowledges the handoff,
not a completed update. The helper launches staging and validation outside the
Gateway process tree while the old Gateway keeps serving, including during
bounded candidate repair. It parks the Gateway
only when the orchestrator reaches `activating`, then completes the existing
commit-or-cancel handoff. Keep stdout connected to the agent: stopping the service
can terminate the surrounding exec shell (SIGTERM or exit 143), including commands
chained after the update. After a handoff result, use the printed follow-up commands
for the final outcome. Plain terminal updates remain synchronous, and `--no-restart`
does not authorize stopping the agent's Gateway.

Post-core steps follow the verified replacement package, including pnpm updates
that change the target of the global package link. The helper retains the
original installation identity for recovery; a child running from a different
installation is still rejected.

The Gateway core auto-updater requires a managed service restart path. It hands
the CLI update to a detached helper before activation. A foreground
Gateway keeps update hints but leaves installation and activation to the
operator: stop it, run `openclaw update`, then launch it again.

Control-plane `update.run` package-manager updates and supervised git-checkout updates use
the same managed-service handoff instead of replacing the package tree or
rebuilding `dist/` inside the live Gateway process: the Gateway starts a
detached helper, which runs `openclaw update --yes --json` from outside the
Gateway process tree. The Gateway exits only after candidate validation succeeds
and activation begins. If the handoff is unavailable,
`update.run` returns a structured response with the safe shell command to run
manually.

Stored extended-stable selections receive read-only startup and 24-hour update
hints when `update.checkOnStart` is enabled. These checks never apply an update,
start a handoff, restart the Gateway, use stable delay/jitter, or use beta
polling cadence. Explicit foreground updates, bare foreground updates with
stored `update.channel: "extended-stable"`, on-demand status, and their managed
Gateway handoff remain supported.

With a local managed service and restart enabled, candidate validation precedes
the stop as described above. The updater reports `Gateway: restarted and verified.`
only after the restarted service passes verification. Plugin-owned readiness
checks run against an isolated state snapshot and do not run interactive setup,
download models, or change config. Readiness owners are selected before their
health APIs load, so unrelated optional Doctor checks cannot interrupt the gate.
Selected checks remain mandatory, including when a required artifact is missing.

Code updates do not require permission to rewrite the native service definition.
On Linux, sealed or unverified definition-write authority skips metadata refresh,
even when metadata is stale. An inspectable service owned by the updated install
still uses its native manager for restart and health/version verification.
Activation runs the updated CLI with `gateway restart --preserve-definition` so
its own version guards apply and automatic repair stays disabled. If the target
CLI does not support that option, it rejects activation before repair. The code
update stays installed, but the command exits nonzero with the activation error
(on stderr in JSON mode). A service stopped for the update may remain stopped.
Run `openclaw gateway status --deep` and ask the deployment owner to restart it
through its native manager or repair stale metadata; do not retry without the
preservation option unless definition repair is intended.

Shell installers do not establish the same service ownership proof. If their
service refresh is denied, they report code installation success, leave the
service untouched, and print guidance to inspect ownership and restart manually.

On Linux without a service manager, updates proceed when native inspection proves
the service is absent and the selected Gateway has no active lock or listener.
The command reports that there is no Gateway to restart. Existing service files,
manager runtime state, or failed filesystem inspection still require service access.

If service inspection is unavailable or installation ownership is unresolved,
the update refuses to mutate the checkout or package tree, including with
`--no-restart`. It cannot assess another service-owned profile's databases from
the invoking profile alone. Run `openclaw gateway status --deep` and retry when
ownership can be inspected. Proven-absent services and inspectable stopped
services remain supported. Services owned by another install remain untouched.

The published 2026.8.2 CLI also refuses updates on service-less Linux installs.
Use `openclaw update --no-restart` for that upgrade after confirming that no Gateway
is running; the new CLI cannot fix the old CLI's pre-update inspection.

Package-manager updates normally keep using the Node binary recorded in the
managed service. If that Node cannot run the target release, but the current
CLI Node can and the service is proven to belong to the package being updated,
a restart-enabled update uses the current Node for finalization and rewrites
the service metadata to that runtime. `--no-restart` cannot repair service
metadata, so the same runtime mismatch stops before package mutation.

On macOS, the post-update check also verifies the LaunchAgent is
loaded/running for the active profile and the configured loopback port is
healthy. If the plist is installed but launchd is not supervising it, OpenClaw
re-bootstraps the LaunchAgent automatically and reruns the health/version/
channel readiness checks (a fresh bootstrap loads the `RunAtLoad` job directly,
so recovery does not immediately `kickstart -k` the newly spawned Gateway).
When preserving a definition, native restart/bootstrap runs without file repair;
a failed native activation or health check does not trigger a later plist rewrite. If
the Gateway still does not become healthy, the command exits non-zero and
prints the restart log path plus restart, reinstall, and package rollback
instructions.

If restart cannot run, the command prints `Gateway: restart skipped (...)` or
`Gateway: restart failed: ...` with guidance to inspect the service and restart manually.
With `--no-restart`, package replacement or git rebuild still runs, but the
managed service is not stopped or restarted, so the running Gateway keeps old
code until you restart it manually.

### Control-plane response shape

When `update.run` runs through the Gateway control plane on a package-manager
install or supervised git checkout, the handler reports handoff initiation
separately from the CLI update that continues in the detached helper:

- `ok: true`, `result.status: "skipped"`,
  `result.reason: "managed-service-handoff-started"`, and
  `handoff.status: "started"`: the Gateway created the managed-service handoff
  so the detached helper can run `openclaw update --yes --json` outside the live
  service process. The old Gateway stays available during validation; this
  response does not mean the service has stopped or the update has completed.
- `ok: false`, `result.reason: "managed-service-handoff-unavailable"`, and
  `handoff.status: "unavailable"`: OpenClaw could not find a supervising
  service boundary and durable service identity for a safe handoff (for
  example, systemd handoff requires the `OPENCLAW_SYSTEMD_UNIT` unit identity,
  not just ambient systemd process markers). The response includes
  `handoff.command`, the shell command to run from outside the Gateway.
- `ok: false`, `result.reason: "managed-service-handoff-failed"`: the Gateway
  tried to create the handoff but could not spawn the detached helper.

The `sentinel` payload is written before the Gateway exits, and the CLI
handoff updates that same restart sentinel after the managed-service restart
health checks complete. During the handoff, the sentinel can carry
`stats.reason: "restart-health-pending"` with no success continuation; the
restarted Gateway polls it and fires the continuation only after the CLI has
verified service health and rewritten the sentinel with the final `ok` result.
`openclaw status` and `openclaw status --all` show an `Update restart` row
while that sentinel is pending or failed. `update.status` retains the latest
sentinel and also returns the durable run record. The sentinel carries
`stats.runId`; the run record remains available after notice delivery consumes
the sentinel.

## Git checkout flow

### Channel selection

- `stable`: select the latest non-beta tag.
- `beta`: prefer the latest `-beta` tag, falling back to the latest stable tag
  when beta is missing or older.
- `dev`: fetch `main` and rebase the candidate.
- `extended-stable`: unsupported for Git checkouts; no checkout mutation
  occurs.

### Update steps

<Steps>
  <Step title="Verify clean worktree">
    Requires no uncommitted changes.
  </Step>
  <Step title="Resolve the target">
    Selects the channel's tag or branch and fetches upstream as needed. If the resolved target SHA equals `HEAD`, finishes `skipped` with reason `already-current` before staging or stopping the service.
  </Step>
  <Step title="Build a candidate">
    Stable, beta, and dev updates install dependencies and build in a temporary worktree while the old Gateway serves. Dev rebases the candidate first so local commits are preserved and the build validates the exact source that will be activated. On POSIX, staging uses a private directory in the checkout's existing ignored `.artifacts` area. By default, the full workspace stays on the checkout filesystem, not a potentially small system temporary filesystem. An existing `.artifacts` redirect is honored as an operator storage choice, just like the build cache. Existing checkout, parent, and artifact directory permissions are not changed. Windows keeps its short system-drive staging path. Only dev updates walk back through earlier commits; stable and beta updates validate their selected target.

    The updater prepares the built runtime on the destination filesystem and removes the temporary Git worktree registration before changing the live checkout. Cleanup failures remain visible in the update result. If an interruption leaves staging behind, artifact-area staging does not dirty the checkout or block the next update's clean check.

    Dev can walk back up to 10 commits to find the newest buildable candidate. Confirmed ENOSPC storage failures stop immediately with `preflight-insufficient-space`; free space on the preflight staging and package-manager store filesystems before retrying. Shared package-manager stores are not deleted. Update builds skip TypeScript declaration generation by default. Set `OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=0` to explicitly request declarations. Set `OPENCLAW_UPDATE_PREFLIGHT_LINT=1` to also run source lint during this preflight; lint runs in constrained serial mode because user update hosts are often smaller than CI runners.

    The updater already running owns staging. Artifact-area staging first shipped in 2026.8.1; updating to a commit that contains it cannot change an older published updater's first hop, which still stages under the system temporary directory.

    Uses the repo package manager. For pnpm checkouts, the updater bootstraps `pnpm` on demand (via `corepack` first, then a temporary npm installation of the target checkout’s exact pnpm version) instead of running `npm run build` inside a pnpm workspace. If pnpm bootstrap still fails, the updater stops early with a package-manager-specific error instead of trying `npm run build` in the checkout.

  </Step>
  <Step title="Validate the candidate">
    Runs candidate Doctor lint, config and plugin planning, and the isolated migration rehearsal and canary described above. Validation failure leaves the old Gateway serving.
  </Step>
  <Step title="Activate and verify">
    Stops the managed service, checks out the exact candidate SHA, publishes the prepared runtime, and runs required Doctor migrations. It starts and verifies the Gateway without reinstalling dependencies or rebuilding the checkout during downtime.

    If restoring the previous Git runtime fails, the Gateway stays stopped and the failed rollback step records the filesystem error. Pending originals remain in sibling `<runtime>.openclaw-update-<id>.tmp/previous` directories. Preserve those backups and repair the installation before restarting; cleanup does not delete an unrestored original.

  </Step>
  <Step title="Sync plugins">
    With the core serving, syncs plugins to the active channel. Dev uses bundled plugins; stable and beta use npm or ClawHub while preserving recorded source choices. A changed plugin snapshot uses the second maintenance and verification window described above; unchanged plugins do not run another full Doctor pass.
  </Step>
</Steps>

### Plugin sync details

On stable updates, a configured OpenClaw-owned official plugin with no install
record is repaired from the selected core release cohort. This also applies to
`doctor --fix` after an earlier upgrade lost a formerly bundled plugin. Admission
checks that package target before stopping the Gateway; post-core reconciliation
installs it before restart. Existing install records retain their source and
selector policy. Verified official packages use the existing
[capability-consent exemption](/plugins/manage-plugins#capability-consent).

Managed npm plugins on the beta channel select the newest version by semantic
version order from their `beta` and `latest` dist-tags, using the same policy as
the core updater. This includes official plugins with a default/latest catalog
target and managed `@beta` selectors. OpenClaw installs the exact inspected
version and retains the recorded selector for future updates.

ClawHub plugins on the beta channel try their own `@beta` tag. If that release
is unavailable, OpenClaw falls back to the default/latest spec and reports a
warning naming the requested and used targets.
Integrity, compatibility, trust, install-policy, and capability-consent failures
do not trigger fallback. Availability fallback warnings do not fail the core
update. Ordinary exact versions, ranges, and explicit tags other than `beta`
retain their selector.
Doctor can refresh a stale official runtime plugin that is bound to the current
OpenClaw release cohort. That repair stays on the recorded registry, verifies
the replacement artifact, and records its exact version if the npm install was
previously pinned.
Already-current runtime plugins are kept in place; a no-op startup repair does
not reinstall the package or invalidate the migration checkpoint.

When the npm update probe finds a newer release for an exact-pinned official
plugin and post-core convergence retains that pin, the update prints the pin
advisory and reports `postUpdate.plugins.status: "warning"` in JSON. The warning
includes the observed installed and available versions and an explicit command
to replace the pin. Keep the pin if intentional. This advisory does not establish
incompatibility, change the pin, or fail an otherwise successful core update.

<Warning>
If an exact pinned npm plugin update resolves to an artifact whose integrity differs from the stored install record, `openclaw update` aborts that plugin artifact update instead of installing it. Reinstall or update the plugin explicitly only after verifying you trust the new artifact.
</Warning>

<Note>
Post-update plugin sync failures that are scoped to a managed plugin and that the sync path can route around (for example an unreachable npm registry for a non-essential plugin) are reported as warnings after the core update succeeds. The JSON result keeps top-level update `status: "ok"` and reports `postUpdate.plugins.status: "warning"` with `openclaw update repair` and `openclaw plugins inspect <id> --runtime --json` guidance. Unexpected updater or sync exceptions still fail the update result. Fix the plugin install or update error, then rerun `openclaw update repair`. When a failed update leaves a managed plugin unusable, OpenClaw disables its runtime entry and resets active slots without changing the operator-authored `plugins.allow` or `plugins.deny` policy.

After the core Gateway is serving, `openclaw update` runs mandatory **post-core convergence**: it repairs missing configured plugin payloads, validates each _active_ tracked install record on disk, and statically verifies its `package.json` is parseable and its declared `openclaw.extensions` entries are loadable. When a package does not declare OpenClaw extensions, the check instead verifies any explicitly declared npm `main`. Failures from this pass, and an invalid config snapshot, return `postUpdate.plugins.status: "error"` and flip the top-level update `status` to `"error"`, so `openclaw update` exits nonzero and does not restart with the unverified plugin set. The error includes structured `postUpdate.plugins.warnings[].guidance` lines pointing at `openclaw update repair` and `openclaw plugins inspect <id> --runtime --json`. Disabled plugin entries and records that are not trusted-source-linked official sync targets are skipped here (mirroring the `skipDisabledPlugins` policy used by the missing-payload check), so a stale disabled plugin record cannot block an otherwise valid update. A changed plugin snapshot completes the exclusive Doctor maintenance, restart, and runtime verification sequence described above before the run succeeds.

When the updated Gateway starts, plugin loading is verify-only: startup does not run package managers or mutate dependency trees. Package-manager `update.run` restarts are handed to the CLI managed-service path, so the package swap happens outside the old Gateway process and the service health checks decide whether the update can be reported as complete.
</Note>

After an extended-stable core update succeeds, post-core plugin integrity and
convergence target eligible official npm and trusted official ClawHub plugins at the exact installed core
version. For default/`latest` intent, OpenClaw does not query plugin
`@extended-stable` or fall back to npm `latest`; it derives the package version
from the installed core. Explicit version pins, explicit non-`latest` tags,
third-party packages, custom registries, and other sources keep their existing intent.

For package-manager installs, `openclaw update` resolves the target package
version before invoking the package manager. npm global installs use a staged
install: OpenClaw installs the new package into a temporary npm prefix,
lets the candidate package validate the host Node version during `preinstall`,
and verifies the packaged `dist` inventory there. A packed completion guard
stays outside that inventory until `preinstall` succeeds, so package managers
that skip lifecycle scripts also stop before activation. On npm 12 and newer,
the updater approves only the candidate OpenClaw lifecycle; transitive
dependency scripts remain blocked. OpenClaw then swaps the clean package tree
into the real global prefix. If verification fails, post-update doctor, plugin
sync, and restart work do not run from the suspect tree.

Staging uses a unique `.openclaw.update-stage-*` directory inside the target
global `node_modules`, separate from disposable npm rename leftovers. Each
attempt tries to remove only its own staging prefix; leftover cleanup does not
reclaim these stages. If an interrupted update leaves one behind, confirm that
no updater is still using it before removing that exact directory. This separation
does not make simultaneous package swaps safe.

A matching installed version skips core replacement but still converges plugins. Core updates also
refresh core-command completion; full plugin-command completion rebuilds remain explicit
`openclaw completion --write-state` runs.

pnpm and Bun on macOS/Linux stage their owning global project and launchers,
preserving the manager's manifests, locks, and sibling packages for rollback.
Concurrent changes to that global project stop activation. Windows Bun updates
are rejected before the service stops because its binary launchers cannot be
relocated by the staged updater; use the owning Bun manager for a
[manual update](/install/updating#alternative-manual-npm-pnpm-or-bun).
Switching a pnpm- or Bun-owned package install to Git with `--channel dev` is
also rejected before activation. Staged source-checkout exposure currently
requires an npm-owned package symlink; package-to-package updates remain
supported through the owning manager.
