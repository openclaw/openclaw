---
summary: "How `openclaw update` switches channels, checks the new version, hands off the restart, and updates a Git checkout"
read_when:
  - You want to know what an update does before you run one
  - You are debugging a restart handoff or a control-plane update response
  - You maintain a source checkout and need the Git update and plugin sync steps
title: "How an update runs"
---

Channel switching, update validation, the restart handoff, and the Git checkout flow. Part of the [`openclaw update`](/cli/update) reference.

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

Fresh clones are validated before publication. If the destination or staging
folder is replaced during validation, the update stops without changing the
replacement. Choose an empty `OPENCLAW_GIT_DIR` and retry.

### Validation and activation

If the resolved registry package version equals the installed version without changing
the selected channel or installation method, or the Git target SHA equals
`HEAD`, plugin convergence still runs; if plugins and runtime artifacts remain unchanged, the run finishes `skipped` with reason `already-current`. Runtime maintenance can therefore succeed without changing the Git revision. A same-version
explicit `--channel` or installation-method change finishes successfully.
Changed plugins restart a running managed Gateway unless `--no-restart` is set; retained exact pins produce the same advisories as a core update without requiring a restart.

Linux updates also refresh outdated OpenClaw-managed systemd policy when the core
is already current or `--no-restart` is set. This policy-only refresh confirms
`daemon-reload` without stopping the Gateway and preserves operator drop-ins.
Native-definition reconciliation on launchd, Scheduled Tasks, and systemd keeps
custom policy values with an advisory while refreshing recognized old defaults.
For example, `TimeoutStartSec=45` stays unchanged while the old installer value
`TimeoutStopSec=30` becomes `330`. Existing identity and command checks still apply.
Maintenance stops also read the resident Gateway's recorded shutdown budget.
Published 2026.9.5 residents keep their startup budget even after `daemon-reload`;
their first stop therefore uses the short/unknown-budget path. The Gateway's
lifecycle owner fences admission and reports drain progress until idle or the
existing update step deadline (30 minutes by default, 45 for automatic updates).
At that deadline, remaining turns can be interrupted with a warning in update
history; reported write custody refuses the stop and names its owner phase.
Residents without the optional `writeCustody` observation cannot distinguish
backup or migration custody from ordinary root/cron work. At the deadline, they
stop with a warning naming those counts; missing custody information never blocks
the update. The next Gateway starts with the refreshed service policy. An operator drop-in
that still shortens the native timeout is preserved and reported.

Explicit package artifacts, such as tarball paths and URLs, compare known build
IDs before a same-version no-op. Matching known identity leaves the package unchanged;
different or missing identity continues through normal update validation and
installation because a matching version alone does not establish artifact
equality. Registry requests retain their version-based same-version no-op.
Installation-method switches and fresh-profile initialization still retain and
validate the new version even when its build identity matches.

Updates continue with recorded warnings when disposable validation-copy cleanup,
retired derived-cache cleanup, or Git upstream tracking setup fails. Resolve the
reported cause, then run the warning's exact cleanup command or
`openclaw doctor --fix`. Invalid ownership, unsafe state migrations, and a Gateway
that cannot boot or pass readiness still block completion. See
[Status and history](/cli/update/status-and-history) to inspect recorded warnings.

Linux service checks treat an implicit systemd unit name and its explicit
installed name as the same selection, including names with or without the
`.service` suffix. The updater still rechecks service ownership before stopping
the Gateway.

Unavailable service inspection produces a recorded `managed-service` warning,
including the manual restart action. A stale, uninspectable service record cannot
select the update's package root, Node executable, or state directory. Staging,
validation, installation, and Doctor finalization continue in the invoking
installation. Doctor leaves unverified service records unchanged and reports an
advisory; state coordinators and database leases still protect active writers.

The baseline package fingerprint is best effort. If its bounded scan times out,
the update records a warning and continues with the retained package copy.
Rollback then verifies the restored directory identity, package version, and
affected launchers, and records that full fingerprint verification was unavailable.
A baseline scan timeout alone does not fail the update or rollback; detected
changes to the retained copy still refuse restoration. Once a complete baseline
fingerprint is available, recovery checks must match it. These checks use the
caller's per-step allowance without a separate thirty-second scan cap.
If a retained or restored package changes, the failure names the exact package
path to inspect before retrying recovery. Sibling `.openclaw.update-stage-*`
directories are outside that package fingerprint; do not remove stages that
another updater may still be using.

Interrupting a fresh local update before activation records a failed,
`interrupted` history entry while its installation owner is still held.
An interrupted update is not a successful update or a verified rollback.
Unresolved effects remain visible in the update report. Unsupported pending
checkpoint records block further mutable update work and remain unchanged.

For versions that support checks before installation, the old Gateway keeps serving through `staging` and
`validating`. The updater uses the new version to run health checks
(`doctor --lint --json --severity-min error`), config validation, and read-only
plugin resolution and compatibility planning. It also tests migrations and
boots a test Gateway with copied configuration and verified SQLite snapshots in an
isolated temporary state directory. The copied database registry points to the
copied agent databases. Installed plugin payloads and their dependencies are also
copied; the copied install records point to those copies, and their OpenClaw
host links target the staged installation. Literal imports, `require()` calls, and
literal dynamic imports to shared source modules include those modules and their
package metadata in the private copy. Unrelated repository files remain outside
the snapshot.

When a published updater omitted shared modules from an external plugin copy,
the new version’s Doctor can complete the private copy before loading plugin repair
hooks. Recovery requires the original path retained by that updater and matching
source/manifest bytes; it never replaces existing private files or changes the
serving plugin. Complete snapshots do not require the original source to remain
available. Some older managed-state or cross-volume projections do not retain a
recoverable original path, which Doctor reports in the update diagnostics.

Path aliases that resolve to a running package's bundled plugin use the staged
bundled plugin with the same ID when
available, preserving bundled trust. External path installs keep their existing
classification. The live plugin files and host links stay unchanged. Channels,
cron, automatic updates, background task maintenance, and other side services are
suppressed in this canary. Copied task records remain available for startup
validation without recovery or pruning.
The canary also defers session catalog hydration, worker recovery, and startup
maintenance until activation, recording a warning. Required configuration,
database ownership, schema, and migration checks still run before readiness;
plugin runtime loading remains part of validation. The serving Gateway prepares
its session catalogs and maintenance normally after activation.

Update build and validation processes resolve source-linked plugin SDKs from
the staged installation root, even when the serving source launcher passed its own checkout
root. This keeps staged assets and validation independent of the old checkout.

Doctor warnings do not block update checks or readiness after plugin updates.
The updater retains them in the run report shown by `openclaw update status`,
including when an intentional open channel policy requires no configuration change.
Error findings and failed check execution still refuse the update.

These checks do not run an agent turn or require a usable model-auth route.
OAuth-only installations and installations without provider credentials can update.
Auth diagnostics are advisory; optional inference repair runs through triage only
after a failed update has settled. It uses the normal runtime credential resolver,
including shared profiles and OAuth refresh.

The new version answers the updater's native service capability probe before
loading configuration or initializing debug capture. Probing capability does not
open or migrate shared state, so the old Gateway can keep serving while its
database schema is older than the new version's. The installed updater runs first;
this repair takes effect when the version it probes contains the fix.

The invoking updater supplies the capability probe's per-step time budget. The
probe does not impose a separate startup deadline.

Snapshot preparation budgets time for the SQLite database and journal bytes,
including copying and verification passes, with a five-minute startup floor.
It uses the larger of that allowance and the configured per-step timeout.
The deadline extends while private files continue changing. A stalled snapshot
reports its size and applied budget. Snapshot time does not consume the separate
runtime validation budget. Each validation process receives a fresh allowance
that scales with measured database and plugin bytes. An explicit per-step
timeout replaces that derived allowance.
Automatic and chat updates leave that runtime allowance derived from state.
Their request and recovery watchdogs do not become update validation deadlines.
Startup and readiness responses share their own allowance, including reading
the response body.

During a copied update rehearsal, candidate Doctor publishes its lint report
before disposing plugin inspections. Its private state stays owned until disposal
finishes or the owned inspector process tree is confirmed stopped. The disposal
allowance follows measured check time and the remaining published-driver window;
an overrun records a warning with its duration. This also lets the 2026.9.4 driver,
which requires a zero process exit, finish when only disposal is slow.
Supervisor-initiated disposal termination preserves completed checks on Windows
as well as macOS and Linux. Caller cancellation and independent failed exits
remain failures.

When a candidate Doctor completes its checks but its process or output pipes
remain open past the allowance, the updater records an exit-phase warning and
continues with the completed result. Lint completion requires that child's
complete JSON report; a preceding repair's `Doctor complete.` line cannot prove
lint success. Error findings still refuse validation. A child without a completion
result reports `candidate-checks-timeout`, the check phase, and elapsed time.

These deadlines belong to the invoking updater. The published 2026.9.3 and 2026.9.4 updaters
cap their complete rehearsal at five minutes, including the snapshot, and their
later schema inspection at thirty seconds, even with `--timeout 900`. Installing
a newer candidate cannot enlarge those parent-process deadlines on that first
update. Subsequent updates use the newer updater's allowances described above.
Hosts whose checks cannot finish within the 2026.9.4 rehearsal's five-minute window
still need the [manual upgrade recovery path](/install/updating#alternative-re-run-the-installer).

Before copying, the updater measures the shared and agent SQLite database
families and the installed plugin payloads and dependency trees that the
update checks need. Admission includes space for temporary copies and the new version’s
Doctor backup. Active plugin payloads remain in the snapshot so configuration
and startup validation can load them; unreferenced plugin generations are not
copied.

The updater selects the first usable destination with enough measured free space:

1. An explicit `TMPDIR`, when set.
2. A private directory under `<state-dir>.update-captures/`, beside the selected
   state directory on its filesystem.
3. The system temporary directory.

The update report records the measured SQLite and plugin sizes, the total
required space, the checked destinations and their available space, and the
selected location and reason. If none fits, snapshot preparation refuses before
copying with `snapshot-capacity-insufficient` and explains how to free space or
set `TMPDIR`. A path that cannot be allocated is recorded and skipped; if all
fitting paths are unusable, `snapshot-location-unavailable` names their path or
permission errors. Capacity checks do not reserve space against concurrent writes.
The copy worker uses the inventoried plugin plan. If an install record, plugin
owner, or database registration changes before its copy, preparation refuses
that unmeasured state so the next update can inventory it again.
These copies remain disposable validation state; rollback does not restore them.
If even the initial SQLite inspection copy cannot fit, the refusal reports that
required lower bound and marks plugin size as not yet inspected.

Snapshot placement belongs to the updater already running. The published
2026.9.3 and 2026.9.4 updaters prepare their snapshot before the new version’s code runs,
so updating to this fix cannot change that first hop. If their system temporary
filesystem is too small, select another filesystem with sufficient space:

```bash
TMPDIR=/var/tmp openclaw update --yes
```

Subsequent updates use the new updater's measured destination selection.

Live snapshots use SQLite read transactions and private backups while writers
continue. Artifact-preserving planning and Doctor checks retain byte-neutral
copies that leave source SHM unchanged. WAL copies capture a bounded prefix
within one verified WAL generation, so appended commits do not require a quiet database.
Incomplete WAL families and crash journals are recovered privately without
creating missing source sidecars. Inspection budgets include database
and journal sizes, cold startup, and repeated IO passes for every discovered
store. Metadata checks remain cancellable. Copy progress renews the watchdog,
and larger caller allowances are preserved. Workers stop before their private
staging is removed; cleanup failures preserve the original error. If compatibility
cannot be verified, rollback is refused.
Inspection failures report the database or known scope, inspection phase, elapsed
time, and the next action. Check access to the named path, concurrent writers,
and storage performance before retrying. Older candidate workers that cannot
report their current database identify the known scope instead.

If the initial config inspection encounters SQLite lock contention or a changing
snapshot source, the updater repeats that read once. A successful read records a
warning and lets target selection continue. Corruption and other inspection errors
remain failures. A pre-staging failure retains its original diagnostic and next
action in update history once fresh database admission succeeds; unresolved
recovery ownership still prevents terminal publication.

This inspection behavior belongs to the invoking updater. A published 2026.9.4
updater can still fail before staging the candidate. In that case, use the
installation's [manual update method](/install/updating/update-methods), then run
`openclaw update repair` from the updated installation.

Before stopping the previous Gateway, the updater waits for affirmative readiness.
Its observation window uses the canary's measured startup time with headroom for
slow hardware, or the explicit per-step timeout. A transient readiness miss does
not discard the previous generation's rollback eligibility. Native service and
Gateway boot identities must still match through the final observation.

The test Gateway binds a free loopback port and must report `/startupz` as `started`,
then `/readyz` as ready within the runtime validation allowance. Plugin-resolution
errors attributed to a named plugin are recorded without rejecting the update.
An invalid plugin inventory, an unattributed registry error, or failure to meet
the required core startup or readiness checks still fails validation. Failure
records the phase, elapsed time, and bounded diagnostics. The updater attempts
process-tree termination and temporary-state cleanup. If bounded teardown does
not confirm both termination-request completion and child closure, it records a
maintenance warning separately from the validation result. Readiness, child
closure, and temporary-copy cleanup do not prove that every descendant stopped.
Temporary-copy cleanup remains best effort. This reporting belongs to the invoking
updater; the new version cannot change an older updater's teardown behavior.
The startup check proves the new version’s core startup on copied state; live channel and provider
behavior are checked after activation.
Targets that predate migration continuation record runtime validation as
unavailable and use the current updater's existing finalization path. A present
continuation entry with an invalid schema contract still refuses activation.
The database-schema preflight still refuses incompatible downgrades. These older
targets do not support automatic schema-neutral rollback; see
[Downgrade finalization](/install/updating#roll-back-a-package-install).

Blocking update validation failures enter a bounded `repairing` phase using
configured inference. These include failed required Doctor checks, invalid config
or state, invalid or unattributed plugin-registry results, and failed core startup
or readiness checks. The updater reruns the failed check after each attempt and
activates only after it passes. Failed or unavailable repair discards the
staged update and leaves the serving Gateway untouched.
After Doctor migrations complete and validation children shut down, repair reuses
that private copy and its completed checks. If no usable inference route exists,
the attempt is skipped without another snapshot or Doctor pass. Incomplete
migrations or unconfirmed child shutdown require a fresh private copy instead.
Successful repair of a private copy does not mean the update was applied:
the updater validates a fresh copy of the update again before activation. If that check
fails, the report retains the failed update and the command exits nonzero even
when the previous Gateway remains healthy. Successful updates with warnings
exit zero.
Pre-activation repair uses disposable copied state and configuration, then
independently validates surviving update changes before activation, and
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

Managed updates from 2026.9.3 can finish migration through the new runtime
while the original updater retains installation ownership. The new runtime checks
the captured update identity against its live parent before finalizing either a
Git or npm installation. This continuation does not change the recovery limits below.

The new version can be running while verification fails. Recovery guidance uses the
latest observed service state and names the running version when known; an
earlier activation stop does not mean the service remains stopped.

Respawn and update verification use the same progress-aware readiness wait as
Gateway restart. Startup that continues making progress can use the existing
five-minute startup lease. If that lease ends while the same Gateway is still
progressing, verification finishes with a warning and reason `still-starting`.
The process stays running, recovery backups remain available, and the updater
does not restart it again, roll it back, or instruct you to keep it stopped.
Direct updater verification reports `skipped` because readiness is unverified.
For a foreground RPC handoff, the replacement Gateway retains final verification:
the run stays pending and its continuation is preserved until startup verification
settles. A version that has not yet been observed is unknown; a version mismatch
requires an observed serving version that disagrees with the installed target.

When the readiness allowance expires for the same running PID or boot generation
while the restart owner reports waiting for a listener, startup migration, or
healthy settling, the updater records the elapsed wait and startup phase as a warning. It leaves the process starting, keeps readiness
unconfirmed, and retains recovery backups. The run ends `skipped` with reason
`gateway-readiness-unverified`, recording an intentional unverified outcome rather
than success or an indefinite pending run. Observed PID or boot-generation changes
remain failures and enter recovery. Check `openclaw gateway status --deep`
before retiring those backups. A timeout alone does not authorize a recovery
restart or rollback; a refused rollback also leaves the candidate untouched.
A running status alone, a failed probe on an established listener, or an HTTP
`/readyz` failure does not establish startup progress. Those unhealthy-service
observations and concrete version, build, channel, or stopped-service failures
remain failures with their own diagnostics. Doctor reports a qualifying startup
timeout explicitly as `gateway-readiness-unverified`, including after migrated
finalization, and tells the operator that readiness remains unconfirmed.

This warning handling belongs to the updater already running. The published
2026.9.3 and 2026.9.4 parents cannot distinguish pending readiness from verified
success when completing a migrated update, so candidate-only updates cannot
change their backup-retirement and Windows autostart decisions.
The published 2026.9.4 runtime also retains its own ten-second respawn health
wait when it verifies a child it started. Installing a new version cannot change
that already-running wait. The shared respawn readiness wait applies when the
new runtime owns the respawn, including subsequent upgrades driven by it;
candidate-side restart verification uses the new owner when the old updater
hands that work to the installed runtime.

Plugin packages download and sync against the installed target before the managed
Gateway restarts. The service remains stopped through channel/config writes,
plugin convergence, and any required full Doctor migrations. Downloads therefore
count toward downtime. Unchanged plugins use read-only validation and readiness
checks without another full Doctor pass. Service ownership is revalidated after
convergence, and final runtime verification checks the resulting snapshot.

If `update finalize` finds a live Gateway holding maintenance ownership, it uses
the existing restart readiness wait within the remaining finalization allowance.
When that exact process is verified serving the installed version and build,
finalization leaves it running and exits successfully with a warning. The history
records `finalize:doctor` as skipped and identifies the holder. Doctor, config
changes, and plugin convergence remain pending until the next maintenance window:
stop the Gateway through its owner, run `openclaw update repair`, then start it
through the same owner. Deferred finalization does not resolve earlier interrupted
updates. A dead process releases its physical maintenance lock; its stale lease
does not qualify for this warning path. Ordinary maintenance admission and lease
reclamation still apply, including refusals for unsafe or unreadable state.

This behavior lives in the installed finalizer, so published updaters can use it
when they invoke the new version's `update finalize`. Older parents may omit the
warning from their own summary; the finalizer prints it and records it in update
history.

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
verification is schema-neutral only at the schema version supported by the new installation
for that database kind; a missing pre-existing database or a new database at a foreign
version blocks rollback. Newly created databases must also be readable by the
previous package; unknown or incompatible support refuses rollback with
`rollback-state-unverified`. The updater restores the previous generation and verifies
it running before finishing `rolled-back`, preserving the failing check as its
reason. See [Automatic rollback](/install/updating#automatic-schema-neutral-rollback)
for the restoration and package-manager guards. The new version’s own Doctor
migrations in the main config file do not block rollback, including on a fresh
install’s first update. Separate `$include` files must retain their pre-activation
configuration content. Doctor must have consumed the captured pre-update config,
and the current file must match its reported output. Restoration holds the normal config writer lock and
rechecks the captured hash before writing.
When needed, rollback replaces the main config with the exact bytes captured before
Doctor and owner-only permissions (`0600`), including the previous writer stamp.
Operator edits made after activation block
restoration, including edits before Doctor reads the config or after its last write; the next action names the changed config file. A failure alone does not
authorize restarting the new version.

If the config file changed after the activation Doctor pass or the databases are
not schema-neutral, automatic rollback is refused with
`state-migrated-no-rollback`. The updater enters `repairing` on the installed
version, also used if rollback itself fails. If the previous package was
already restored, repair targets that version. Between repair attempts, the
updater starts or restarts a stopped or unhealthy service once and reruns the
post-restart verification checks. Successful verification finishes the run as
`succeeded` for the new version, or `rolled-back` for the restored release with a
nonzero command exit. Failed repair preserves the original failure and attempt summaries.
Use the recorded diagnostics and [Triage](/cli/triage) for remaining failures,
preserving migrated state. These temporary validation
snapshots are not a full-state backup; see [Rollback](/install/updating#rollback).
If schema state cannot be verified, rollback is refused with
`rollback-state-unverified`; unknown state never counts as schema-neutral.

### Restart handoff

Service-manager commands and helper acknowledgements share the activation or
recovery allowance. Slow inspection or teardown does not impose a separate
five- or thirty-second command cutoff. Service installation also forwards one
caller budget through staging, sealing, and load; the parent owns cancellation.

When an agent runs `openclaw update` inside a systemd user service or macOS
LaunchAgent Gateway, the CLI hands the update to the same managed-service helper
before stopping the Gateway. It prints the helper log path and follow-up commands
for update status and Gateway health, then exits; this acknowledges the handoff,
not a completed update. The acknowledging CLI exits with code `75` (`EX_TEMPFAIL`)
so scripts cannot mistake accepted background work for a completed update. The
detached helper remains the settlement authority; use the printed status and
health commands to retrieve its terminal result. The helper launches staging and validation outside the
Gateway process tree while the old Gateway keeps serving, including during
bounded update repair. It parks the Gateway
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
records, which predate the recorded Linux service-manager UID. The new version
still revalidates service ownership, profile, unit, and protected launcher data.
When the handoff records a manager UID, a different UID blocks service mutation.

The Gateway core auto-updater requires a managed service restart path. It hands
the CLI update to a detached helper before activation. A foreground
Gateway keeps update hints but leaves installation and activation to the
operator: stop it, run `openclaw update`, then launch it again.

Control-plane `update.run` uses the same detached CLI update owner for
package-manager and Git installations, including a verified foreground Gateway.
The Gateway stays available during validation. Before replacing its installed
code, the updater asks that exact Gateway to drain work and close its services,
databases, and listener. A foreground Gateway launches a fresh process only after
the updater settles; it does not reopen its old module graph after replacement.
Managed services restart through their existing service manager.

With `OPENCLAW_NO_RESPAWN` enabled, a foreground Gateway refuses `update.run`
before starting the updater. Stop the Gateway, run `openclaw update`, and start
it again, or relaunch it without `OPENCLAW_NO_RESPAWN` to allow control-plane updates.

Each requested update checks the current local installation and Git upstream
before accepting its target. After a pinned Git update leaves the checkout
detached, a verified update receipt preserves the upstream for that same checkout
and revision. Startup status discovery does not freeze later update requests.

A foreground replacement can still be starting when the initial readiness
observation ends. OpenClaw leaves that process running and reports readiness as
unverified. Use `openclaw gateway status --deep` to check its progress.
Successful updates remain pending until the replacement verifies startup.

If readiness rejects a foreground replacement, OpenClaw requests a graceful shutdown
and reports shutdown as pending with the replacement PID. The old Gateway process
waits for that replacement to close. If shutdown does not finish, inspect the
replacement's startup logs and active updates before stopping it manually.

Stopping a foreground Gateway during helper startup, package staging, or activation
waits for owned update work to finish, then leaves the Gateway stopped. New updates
and unrelated restarts cannot bypass that wait. If cleanup ownership is uncertain,
the Gateway remains draining; after checking the updater, send Stop again to recheck
the same work. A replacement already starting is also stopped. Pending startup
verification runs on the next Gateway start.
The previous package backup remains available while that verification is pending.

Stored extended-stable selections receive read-only startup and 24-hour update
hints when `update.checkOnStart` is enabled. These checks never apply an update,
start a handoff, restart the Gateway, use stable delay/jitter, or use beta
polling cadence. Explicit foreground updates, bare foreground updates with
stored `update.channel: "extended-stable"`, on-demand status, and their managed
Gateway handoff remain supported.

<a id="candidate-validation-and-service-definitions" />

#### Update validation and service definitions

With a local managed service and restart enabled, update validation precedes
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
The command reports that there is no Gateway to restart.

If service inspection is unavailable or installation ownership is unresolved,
the update continues with a warning and leaves the recorded service unchanged.
An unverified record cannot select the update's package, Node runtime,
configuration, or state directory. Restart the Gateway you launched manually
after the update, and use `openclaw gateway status --deep` to inspect the record.
Verified services still select their own installation and state directory;
ownership conflicts, pending recovery, and active state writers retain their
existing admission checks. Services owned by another install remain untouched.

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
updater does not stop or restart the Gateway. A running Gateway can still exit
when it detects that its installation was replaced; restart it through its
service or foreground process owner afterward.

When updater-owned Doctor reaches maintenance before that foreground Gateway
finishes shutting down, it waits for the same process to release state, up to
the installation-check interval plus the existing restart-drain and service-stop
allowances. Doctor retains the updater's live authority and still acquires its
normal maintenance locks before repairing state.
If shutdown has already removed the process identity, Doctor allows only the
existing ten-second cleanup reserve and refuses any newly appearing owner.
A different Gateway owner, lost update authority, or unresolved contention stops
maintenance with recovery guidance. Ordinary Doctor commands and older update
drivers without delegated Doctor authority retain their immediate refusal.

Published 2026.9.5 Gateways do not have an installation-replacement watcher.
Installing a newer candidate cannot add that behavior to the process already
running. For that first foreground update, stop the Gateway through its foreground
process owner and wait for it to exit, run `openclaw update`, then launch the
Gateway again. Keep the same installation, profile, and state/config overrides.
`--no-restart` does not authorize Doctor to stop that process or skip required
state maintenance.

If the package was already replaced and Doctor failed on the live Gateway lock,
wait for the updater to exit, stop the foreground Gateway through its owner, and
run `openclaw update repair --yes --no-restart --json` from the updated installation.
Verify the repair result before starting the Gateway again. Preserve the existing
state and recovery backups; replacing files alone does not complete maintenance.

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
- `dev`: fetch `main` and rebase the staged checkout.
- `extended-stable`: unsupported for Git checkouts; no checkout mutation
  occurs.

### Update steps

<Steps>
  <Step title="Verify clean worktree">
    Requires no uncommitted changes. Local edits fail the clean check before installation or service shutdown; the checkout is preserved. Commit your changes and retry, or run `openclaw triage` for help.
  </Step>
  <Step title="Resolve the target">
    Selects the channel's tag or branch and fetches upstream as needed. If the resolved target SHA equals `HEAD`, finishes `skipped` with reason `already-current` before staging or stopping the service.

    Shallow and partial source checkouts retain their installed refs, shallow boundaries, and object database during target inspection. Missing objects are fetched into the private inspection repository through the checkout's configured remotes. This behavior belongs to the installed updater; an older updater that fails with `Git target inspection clone failed` needs its checkout's missing objects fetched before retrying.

  </Step>
  <Step id="build-a-candidate" title="Build the update">
    Stable, beta, and dev updates install dependencies and build in a temporary worktree while the old Gateway serves. Dev rebases the staged checkout first so local commits are preserved and the build validates the exact source that will be activated. On POSIX, staging uses a private directory in the checkout's existing ignored `.artifacts` area. By default, the full workspace stays on the checkout filesystem, not a potentially small system temporary filesystem. An existing `.artifacts` redirect is honored as an operator storage choice, just like the build cache. Existing checkout, parent, and artifact directory permissions are not changed. Windows keeps its short system-drive staging path. Only dev updates walk back through earlier commits; stable and beta updates validate their selected target.

    The updater prepares the built runtime (`dist`, `dist-runtime`, and dependencies, including nested workspace outputs) on the destination filesystem and removes the temporary Git worktree registration before changing the live checkout. Cleanup failures remain visible in the update result. If an interruption leaves staging behind, artifact-area staging does not dirty the checkout or block the next update's clean check.

    Dev can walk back up to 10 commits to find the newest buildable version. Confirmed ENOSPC storage failures stop immediately with `preflight-insufficient-space`; free space on the preflight staging and package-manager store filesystems before retrying. Shared package-manager stores are not deleted. Update builds skip TypeScript declaration generation by default. Set `OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=0` to explicitly request declarations. Set `OPENCLAW_UPDATE_PREFLIGHT_LINT=1` to also run source lint during this preflight; lint runs in constrained serial mode because user update hosts are often smaller than CI runners.

    The updater already running owns staging. Artifact-area staging first shipped in 2026.8.1; updating to a commit that contains it cannot change an older published updater's first hop, which still stages under the system temporary directory.

    Uses the repo package manager. For pnpm checkouts, the updater bootstraps `pnpm` on demand (via `corepack` first, then a temporary npm installation of the target checkout’s exact pnpm version) instead of running `npm run build` inside a pnpm workspace. If pnpm bootstrap still fails, the updater stops early with a package-manager-specific error instead of trying `npm run build` in the checkout.

  </Step>
  <Step id="validate-the-candidate" title="Check the update">
    Runs Doctor health checks, config and plugin planning, and the isolated migration and test Gateway checks described above. Validation failure leaves the old Gateway serving.
  </Step>
  <Step title="Activate and verify">
    Stops the managed service, checks out the exact staged commit SHA, publishes the prepared runtime, and runs required Doctor migrations. Core dependencies and the checkout build were prepared before downtime; plugin convergence follows while the service remains stopped.

    If restoring the previous Git runtime fails, the Gateway stays stopped and the failed rollback step records the filesystem error. Pending originals remain in sibling `<runtime>.openclaw-update-<id>.tmp/previous` directories. Preserve those backups and repair the installation before restarting; cleanup does not delete an unrestored original.

  </Step>
  <Step title="Sync plugins">
    Against the installed target, syncs plugins to the active channel before restarting the managed service. Dev uses bundled plugins; stable and beta use npm or ClawHub while preserving recorded source choices. A changed plugin snapshot runs fresh Doctor migrations; unchanged plugins do not run another full Doctor pass. The updater then revalidates the service owner, starts the Gateway, and verifies the final snapshot.

    Source targets that support runtime completion also check their generated plugin runtime overlay and SDK aliases before loading plugin configuration. This completes artifacts omitted by an older updater on the first update to such a target; `update repair` performs the same check before Doctor. Exact artifacts remain untouched, including while a Gateway is running. Replacing missing or stale artifacts requires proof that the affected runtime is offline. A Gateway serving a physically separate runtime does not block completion. If service ownership or offline status cannot be verified, completion fails with recovery guidance instead of reporting a successful update. Older targets retain their existing generation behavior. Clean-source and staged-build validation still apply.

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

Older updaters may still refuse with `plugin-target-unavailable` before the new version’s
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
lets the staged package validate the host Node version during `preinstall`,
and verifies the packaged `dist` inventory there. A packed completion guard
stays outside that inventory until `preinstall` succeeds, so package managers
that skip lifecycle scripts also stop before activation. On npm 12 and newer,
the updater approves only the staged OpenClaw package’s lifecycle; transitive
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

When an npm package link points to a built Git checkout, rollback verifies that
same checkout and build before restoring the link and launchers. Local source
edits are preserved. Replacing the checkout or rebuilding it during the update
prevents automatic rollback; restoring a link alone does not prove runtime safety.

### Local packaged overrides

Package updates preserve local `dist` edits in a recovery bundle before replacing
the old package. Capture happens after service drain and the old-tree move, so
edits made while the new version installs are included. The report names the bundle
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
against the private staged package before it replaces the live package. Publication
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
