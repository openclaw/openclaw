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

If the resolved registry package version equals the installed version without changing
the selected channel or installation method, or the Git target SHA equals
`HEAD`, plugin convergence still runs; if plugins remain unchanged, the run finishes `skipped` with reason `already-current`. A same-version
explicit `--channel` or installation-method change finishes successfully.
Changed plugins restart a running managed Gateway unless `--no-restart` is set; retained exact pins produce the same advisories as a core update without requiring a restart.

Explicit package artifacts, such as tarball paths and URLs, still pass through
validation and installation when their version matches the installed version.
A matching version alone does not establish artifact equality.

Updates continue with recorded warnings when disposable validation-copy cleanup,
retired derived-cache cleanup, or Git upstream tracking setup fails. Resolve the
reported cause, then run the warning's exact cleanup command or
`openclaw doctor --fix`. Invalid ownership, unsafe state migrations, and a Gateway
that cannot boot or pass readiness still block completion. See
[Status and history](/cli/update/status-and-history) to inspect recorded warnings.

The baseline package fingerprint is best effort. If its bounded scan times out,
the update records a warning and continues with the retained package copy.
Rollback then verifies the restored directory identity, package version, and
affected launchers, and records that full fingerprint verification was unavailable.
A timeout alone does not fail the update or rollback; detected changes to the
retained copy still refuse restoration.

Interrupting a fresh local update before activation records a failed,
`interrupted` history entry while its installation owner is still held.
An interrupted update is not a successful update or a verified rollback.
Unresolved effects remain visible in the update report. Unsupported pending
checkpoint records block further mutable update work and remain unchanged.

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

Candidate build and rehearsal processes resolve source-linked plugin SDKs from
the candidate root, even when the serving source launcher passed its own checkout
root. This keeps candidate assets and validation independent of the old checkout.

Snapshot preparation budgets time for the SQLite database and journal bytes,
including copying and verification passes, with a five-minute startup floor.
It uses the larger of that allowance and the configured per-step timeout.
The deadline extends while private files continue changing. A stalled snapshot
reports its size and applied budget. Snapshot time does not consume the separate
runtime validation budget, which also honors the configured per-step timeout.

Before copying databases, the updater estimates space for the SQLite snapshot
set, temporary copies, and the candidate Doctor backup. If the system temporary
filesystem is too small, it uses an OpenClaw-owned directory under the selected
state directory's `tmp` folder. If neither filesystem has enough space, it
refuses with the required size and the available space at both locations.
Capacity estimates cannot reserve space against other processes writing to the
same filesystem.

Schema checks also use private SQLite copies so inspection does not create or
modify WAL sidecars beside live databases. Each schema inspection has a
30-second deadline; if compatibility cannot be verified, rollback is refused.

The canary binds a free loopback port and must report `/startupz` as `started`,
then `/readyz` as ready within the configured per-step timeout. Plugin-resolution
errors attributed to a named plugin are recorded without rejecting the candidate.
An invalid plugin inventory, an unattributed registry error, or failure to meet
the required core startup or readiness checks still fails validation. Failure
records the phase, elapsed time, and bounded diagnostics; the canary process group
and temporary state are cleaned up. This proves candidate core startup on copied
state; live channel and provider behavior are checked after activation.
Targets that predate migration continuation record runtime validation as
unavailable and use the current updater's existing finalization path. A present
continuation entry with an invalid schema contract still refuses activation.
The database-schema preflight still refuses incompatible downgrades. These older
targets do not support automatic schema-neutral rollback; see
[Downgrade finalization](/install/updating#roll-back-a-package-install).

Blocking candidate validation failures enter a bounded `repairing` phase using
configured inference. These include failed required Doctor checks, invalid config
or state, invalid or unattributed plugin-registry results, and failed core startup
or readiness checks. The updater reruns the failed check after each attempt and
activates only after it passes. Failed or unavailable repair discards the
candidate and leaves the serving Gateway untouched.
Pre-activation repair uses disposable rehearsal state and configuration, then
independently validates surviving candidate changes before activation, and
`repair-requires-config-change` reports changed top-level keys that require
operator-run `openclaw doctor --fix` or `openclaw triage`. Post-activation
finalization may use live repair when compatibility-checked package rollback is
unsafe or fails. See
[Unattended repair](/install/updating#unattended-repair-on-your-own-inference) for
budgets, permitted repairs, and attempt reports.

Only `activating` stops the managed service. Its offline work includes the package
or checkout swap, required `doctor --fix` migrations, and state compatibility
inspection, followed by service start
in `restarting`. Update verification does not use model inference. In `verifying`,
the updater checks that the managed service is running and owns its port, requires
the normal 12-probe health settle and a Gateway hello handshake matching the
expected version and Git build identity, checks channel readiness, and requires
HTTP 200 from `/readyz`. Plugin activation or load failures remain named warnings
when these core checks pass; they do not turn a successful core update into an error.

A candidate can be running while verification fails. Recovery guidance uses the
latest observed service state and names the running version when known; an
earlier activation stop does not mean the service remains stopped.

Plugin packages download and sync against the installed target before the managed
Gateway restarts. The service remains stopped through channel/config writes,
plugin convergence, and any required full Doctor migrations. Downloads therefore
count toward downtime. Unchanged plugins use read-only validation and readiness
checks without another full Doctor pass. Service ownership is revalidated after
convergence, and final runtime verification checks the resulting snapshot.

<a id="durable-serving-recovery" />

### Recovery limits

Automatic rollback restores a retained package only when the current schema and
configuration are compatible with the previous release. This update path does
not capture or replay a full-state checkpoint and cannot reverse database
migrations. Private snapshots used for validation are disposable and are not a
recovery backup. Before a significant update, create an
[independent verified backup](/install/updating#before-updating-create-a-verified-backup).

Unknown or changed schema/configuration does not authorize a restore. When
compatibility cannot be established, the updater refuses rollback, preserves
state and retained package material, and reports the failed operation. Restoring
an older package alone is not proof that the service can safely start.

Existing pending records that require checkpoint replay are unsupported by this
update path. `openclaw update` reports them before ordinary mutable update work;
it does not replay, rewrite, retire, or clear their retained state. `update
finalize` does not bypass that refusal. Preserve the records and any named
recovery artifacts for recovery with a compatible implementation or a verified
backup. A later invocation must not label an unresolved interrupted run successful.

<a id="legacy-package-rollback" />

### Compatibility-checked package rollback

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

Updates from stable 2026.9.2 and 2026.9.3 retain support for their service handoff
records, which predate the recorded Linux service-manager UID. The candidate
still revalidates service ownership, profile, unit, and protected launcher data.
When the handoff records a manager UID, a different UID blocks service mutation.

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

#### Candidate validation and service definitions

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

#### Shell installers

Shell installers do not establish the same service ownership proof. If their
service refresh is denied, they report code installation success, leave the
service untouched, and print guidance to inspect ownership and restart manually.

#### Linux without a service manager

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

#### Node runtime for package-manager updates

Package-manager updates normally keep using the Node binary recorded in the
managed service. If that Node cannot run the target release, but the current
CLI Node can and the service is proven to belong to the package being updated,
a restart-enabled update uses the current Node for finalization and rewrites
the service metadata to that runtime. `--no-restart` cannot repair service
metadata, so the same runtime mismatch stops before package mutation.

#### macOS LaunchAgent verification

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

#### When restart is skipped or fails

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
    Stops the managed service, checks out the exact candidate SHA, publishes the prepared runtime, and runs required Doctor migrations. Core dependencies and the checkout build were prepared before downtime; plugin convergence follows while the service remains stopped.

    If restoring the previous Git runtime fails, the Gateway stays stopped and the failed rollback step records the filesystem error. Pending originals remain in sibling `<runtime>.openclaw-update-<id>.tmp/previous` directories. Preserve those backups and repair the installation before restarting; cleanup does not delete an unrestored original.

  </Step>
  <Step title="Sync plugins">
    Against the installed target, syncs plugins to the active channel before restarting the managed service. Dev uses bundled plugins; stable and beta use npm or ClawHub while preserving recorded source choices. A changed plugin snapshot runs fresh Doctor migrations; unchanged plugins do not run another full Doctor pass. The updater then revalidates the service owner, starts the Gateway, and verifies the final snapshot.
  </Step>
</Steps>

## Plugin sync details

On stable updates, a configured OpenClaw-owned official plugin with no install
record is repaired from the selected core release cohort. This also applies to
`doctor --fix` after an earlier upgrade lost a formerly bundled plugin. Post-core
reconciliation attempts installation before restart; an unavailable target remains
a named warning while the core update continues. Existing records keep their
registry and source choices. Verified official packages use the existing
[capability-consent exemption](/plugins/manage-plugins#capability-consent).

Eligible managed release pins for npm and trusted official ClawHub installs of
`@openclaw/*` packages resume the catalog's default selector after a successful
update. The recorded selector must be an exact OpenClaw release no newer than the
installed core, and the same package must have a verified default catalog target.
This includes previously recorded automatic and manual pins. An explicit selector
supplied to the current plugin update command takes precedence. Pins outside that
eligibility, ranges, explicit tags, and other sources keep their existing policy.

Managed npm plugins on the beta channel select the newest version by semantic
version order from their `beta` and `latest` dist-tags, using the same policy as
the core updater. This includes official plugins with a default/latest catalog
target and managed `@beta` selectors. OpenClaw installs the exact inspected
version while keeping the selected tag or restored catalog default for future updates.

ClawHub plugins on the beta channel try their own `@beta` tag. If that release
is unavailable, OpenClaw falls back to the default/latest spec and reports a
warning naming the requested and used targets.
Integrity, compatibility, trust, install-policy, and capability-consent failures
do not trigger fallback. Availability fallback warnings do not fail the core
update. Pins outside the managed release-pin recovery described above, ranges,
and explicit tags other than `beta` retain their selector.
Doctor can refresh a stale official runtime plugin that is bound to the current
OpenClaw release cohort. That repair stays on the recorded registry and verifies
the replacement artifact.
Already-current runtime plugins are kept in place; a no-op startup repair does
not reinstall the package or invalidate the migration checkpoint.

When post-core convergence retains an official pin outside automatic release-pin
recovery and the npm probe finds a newer release, the update prints a pin advisory
and reports `postUpdate.plugins.status: "warning"` in JSON. The warning includes
the observed installed and available versions and an explicit command to replace
the pin. Keep the pin if intentional. This advisory does not establish
incompatibility, change the pin, or fail an otherwise successful core update.

An unavailable npm target or unreachable registry does not fail an otherwise
successful core update. When a compatible, runnable plugin is installed, plugin
sync retains that
installed version and its recorded selector. The summary, warning log, and run
history name the plugin, requested target, resolution failure, and
`openclaw plugins update <id>` next action. JSON keeps top-level `status: "ok"`
with a `plugin-target-unavailable` advisory under `postUpdate.plugins.warnings`.

Before mutation, OpenClaw checks installed compatibility metadata and skips
registry queries for compatible plugins. If a plugin's declared
`openclaw.compat.pluginApi` range or `openclaw.install.minHostVersion` excludes
the target core and a compatible replacement cannot be resolved, it records a
named notice and continues the core update. The plugin can remain unavailable
until a compatible version can be installed. Configuration, ownership, schema,
and core readiness checks still have to pass.

Older updaters may still refuse with `plugin-target-unavailable` before candidate
code runs. Use your installation's [manual update method](/install/updating/update-methods),
then run `openclaw update repair` from the updated installation.

<Warning>
If an exact pinned npm plugin update resolves to an artifact whose integrity differs from the stored install record, `openclaw update` aborts that plugin artifact update instead of installing it. Reinstall or update the plugin explicitly only after verifying you trust the new artifact.
</Warning>

<Note>
Plugin-only availability, installation, and load failures are reported as named,
actionable warnings after an otherwise successful core update. JSON keeps
top-level `status: "ok"` and reports `postUpdate.plugins.status: "warning"`.
Follow the command in `postUpdate.plugins.warnings[].guidance`. For a named
plugin, retry failed installs or updates with `openclaw plugins update <id>`;
use `openclaw doctor --fix` for load problems.
A failed plugin operation retains previous payloads and install records where
possible and preserves registry choices, plugin settings, enable/disable choices,
and active slots. A plugin can remain unavailable until repaired.

After installing the core and before restarting the managed Gateway,
`openclaw update` runs mandatory **post-core convergence**: it repairs missing
configured plugin payloads, validates each _active_ tracked install record on disk,
and statically verifies its `package.json` is parseable and its declared
`openclaw.extensions` entries are loadable. When a package does not declare
OpenClaw extensions, the check instead verifies any explicitly declared npm
`main`. Missing or unloadable plugin payloads add warnings while the core update
continues. An invalid config snapshot still returns
`postUpdate.plugins.status: "error"`, makes the top-level update `status`
`"error"`, and exits nonzero. Invalid state, ownership errors, failed required
Doctor or readiness checks also remain errors. Disabled plugins are skipped unless their records are trusted official
sync targets. A changed plugin snapshot completes fresh Doctor and, when restart
is requested, the Gateway restart and core runtime verification described above
before the run succeeds.

When the updated Gateway starts, plugin loading is verify-only: startup does not run package managers or mutate dependency trees. Package-manager `update.run` restarts are handed to the CLI managed-service path, so the package swap happens outside the old Gateway process and the service health checks decide whether the update can be reported as complete.
</Note>

After an extended-stable core update succeeds, post-core plugin integrity and
convergence target eligible official npm and trusted official ClawHub plugins at
the exact installed core version. For default/`latest` intent, OpenClaw does not
query plugin `@extended-stable` or fall back to npm `latest`; it derives the
package version from the installed core. Eligible managed release pins resume
the catalog default under the recovery rules above. Pins outside that eligibility,
explicit non-`latest` tags, third-party packages, custom ClawHub registries, and
other sources keep their existing intent. An explicit selector supplied for the
current plugin operation takes precedence.

## Package-manager installs

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

### Local packaged overrides

Package updates preserve local `dist` edits in a recovery bundle before replacing
the old package. Capture happens after service drain and the old-tree move, so
edits made while the candidate installs are included. The report names the bundle
under the selected state directory's `update-recovery/` directory. Keep it until
you have checked the updated installation; removal is manual.

By default, the update installs the new package without replaying local code.
To replay edits you trust during that update:

```bash
openclaw update --reapply-local-overrides
```

Packages that advertise a content inventory record shipped file hashes and
executable status. Replay requires the new package's corresponding baseline and
actual bytes to match; upstream changes, unsafe paths, and hardlinked targets
prevent replay. A conflict leaves the whole override set in the recovery bundle.
Unreferenced content-hashed additions also require manual recovery. Replay runs
against the private candidate before it replaces the live package. Publication
and restoration refuse to overwrite a destination created concurrently. Replay
does not establish that local code remains compatible with the new release.

Older packages without content inventories cannot distinguish local edits from
vendor files. Their regular `dist` files are preserved for manual inspection,
with no automatic replay, even when the flag is set. Keep enough free space for
that copy; recovery bundles are not automatically pruned. Dependency trees and
inventory metadata are not local override payloads. Symlinks and other unsupported
entries can refuse the update, including entries in otherwise excluded `dist`
subtrees; repair those entries before retrying. Normal package-manager permission changes,
such as applying the installer's umask, are not treated as local edits.

Preserved overrides are separate from automatic package rollback. A failed update
still follows the existing ownership, configuration, schema, and retained-package
checks. If late edits invalidate rollback verification, keep both the named package
backup and override bundle; the report does not authorize restarting an unverified
installation.

This behavior belongs to the updater already running. Back up local edits before
the first upgrade from an older updater that does not include it. Git checkouts
continue to use the existing clean-worktree and Git update rules.
