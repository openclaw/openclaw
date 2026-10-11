---
summary: "Updating OpenClaw safely (global install or source), plus rollback strategy"
read_when:
  - Updating OpenClaw
  - Something breaks after an update
title: "Updating"
---

Keep OpenClaw up to date.

App-owned packages declare their update owner in `openclaw-install-owner.json`
at the package root. For `owner: "macos-app"`, update OpenClaw.app through its
app updater to update the bundled Gateway and runtime together. `openclaw update`,
`openclaw update repair`, and Gateway update requests return the marker's update
hint without changing the package or stopping the Gateway; background checks
skip package-registry updates. Missing or invalid markers retain normal install
behavior, with a warning for an invalid marker.

For Docker, Podman, and Kubernetes image replacements, see
[Upgrading container images](/install/docker#upgrading-container-images). The
image entrypoint runs Doctor before starting the Gateway and exits if mounted
state cannot be repaired safely.

Before upgrading, follow the [preflight checklist](/install/updating/rollback-and-recovery#before-you-upgrade).
Before a significant update, [create a verified backup](#before-updating-create-a-verified-backup).
Automatic config copies and migration recovery originals are not a full-state
backup.

## Retired tenant-container management

The experimental `openclaw fleet` command has been removed. Updating the host
CLI leaves existing tenant containers, networks, mounted data, and registry
records untouched; it does not update their container images.

Before updating, back up each tenant and record its container identity, runtime,
image, ports, mounts, resource limits, and environment. Protect that record as
credentials: container environments can contain Gateway tokens. Transfer
lifecycle, image updates, backups, and cleanup to your Docker or Podman deployment
tooling. Verify each tenant through its existing endpoint before retiring recovery
copies or removing resources. Keep separate state and credentials for each
[trust boundary](/gateway/security/trust-model).

See [container image updates](/install/docker#upgrading-container-images),
[backups](/install/backups), and the
[downgrade limitation](/install/updating/rollback-and-recovery#downgrade) before
changing images or restoring an older OpenClaw version.

## Upgrading very old versions

For installations older than July 2026, upgrade to **`2026.9.5` first**, run its
Doctor migrations, and then upgrade to `latest`. The bridge release still
imports the old `tasks/runs.sqlite`, `flows/registry.sqlite`, and
`plugin-state/state.sqlite` databases, imports the JSON plugin install index,
pre-June plugin JSON state, and
`credentials/oauth.json`, repairs retired agent and channel config keys, and
includes the old runtime aliases. The retired plugin imports cover Telegram,
iMessage, Active Memory, Nostr, and Microsoft Teams; see
[legacy state migration](/cli/doctor/state-migrations). Current releases leave
those retired state files untouched.
If you already installed the latest version, Doctor stops before rewriting config
that still contains these retired keys and directs you through the same bridge.

The retired same-file memory index (`meta`, `files`, and `chunks`) is also refused
before canonical tables are created. Preserve the original state and configuration,
then use **`2026.9.7`** to migrate a compatible copy of that index before retrying.
Unrelated tables with these generic names remain untouched.

If a newer release has already upgraded your SQLite databases, use a compatible
pre-update backup for the bridge. Older releases cannot open newer database
schemas; follow [downgrade recovery](/reference/database-schemas/integrity-and-recovery#downgrade-recovery)
before running either bridge release against that state.

Back up the state first and use a [supported Node version](/install/node):
Node 24.16+ on the 24.x line, or Node 26.1+. Keep the same owning account,
installation prefix, profile, and state/configuration paths throughout.

For an npm installation with an OpenClaw-managed Gateway service, run this
first stage from a terminal:

```bash
openclaw gateway stop &&
  npm install -g openclaw@2026.9.5 --allow-scripts=openclaw &&
  openclaw --version &&
  openclaw doctor --fix
```

Confirm that the version output is `2026.9.5` and that Doctor imported the old
task, flow, plugin, and channel state you need. Resolve any failed or conflicting
imports before continuing. Doctor imports channel state only for enabled channels
and accounts. If needed, temporarily enable those channels while the Gateway is
stopped, rerun the bridge Doctor, then restore their previous enabled settings.
Ensure the affected plugins are installed before running their migrations.
Then install the current release and restart:

```bash
npm install -g openclaw@latest --allow-scripts=openclaw &&
  openclaw doctor --fix &&
  openclaw gateway start &&
  openclaw gateway status --deep
```

These npm commands are for npm 12 or npm 11.16+; on npm 11.15 and earlier, omit
`--allow-scripts=openclaw`. For a pnpm-owned installation, replace each install
command with `pnpm add -g --allow-build=openclaw openclaw@2026.9.5`, then
`pnpm add -g --allow-build=openclaw openclaw@latest`. For Bun, use
`bun add -g --trust openclaw@2026.9.5`, then `bun add -g --trust openclaw@latest`.
Keep any normal `--profile` selector on every `openclaw` command. For a custom
service or foreground Gateway, stop and start it through its actual owner
instead of the managed-service commands above.

## Recommended: `openclaw update`

Detects your install type (npm, pnpm, Bun, or git), checks the new version while
the old Gateway serves, then activates and verifies the update.

```bash
openclaw update
```

Starting with the release that adds [candidate-owned admission](/cli/update#candidate-owned-admission),
package updates privately stage the target and let its code judge configuration,
database schema, Node requirements, and plugin availability before activation.
Later releases can therefore correct these admission decisions for users already
on a supporting updater. The installed updater retains managed-service ownership
and ancestry checks and every mutation. Older installed updaters keep their
pre-staging refusals; a newer candidate cannot repair that first hop. Targets
without the capability marker fall back to installed checks, as do
`--admission installed` and `--dry-run` (which never stages a package).
Admission selection is CLI-only: `--admission auto` is the default, and there is
no environment-variable override.

Windows candidates accept lease identities from the `2026.9.6` updater even
when NTFS file IDs exceed JavaScript's exact numeric range. After validating
the handoff, the candidate retains exact file and parent-directory identities;
later replacement still stops the update. Lease read failures report their
underlying cause instead of a parent-binding mismatch.

Post-install Doctor also accepts older updaters, including `2026.8.2`, that do not
provide an update run ID. Its commands retain invocation-specific custody without
requiring an environment-variable workaround.

Managed-service inspection is best effort. If the service manager is unavailable,
including Linux hosts without systemd, the update continues and records a warning.
It leaves unverified service definitions unchanged and skips their automatic
restart. Restart the Gateway you launched manually after the update, or use its
actual supervisor. Doctor still checks for active state writers before migrations.

On Linux, unmask a managed systemd unit before updating. A masked unit
(`masked` or `masked-runtime`), `RefuseManualStart=yes`, or a disabled and inactive
unit with no start path causes preflight to refuse before replacing files or
running migrations. For the default user service:

```bash
systemctl --user unmask openclaw-gateway.service
openclaw update
```

Use the unit and scope reported by `openclaw gateway status --deep` for a custom
profile or system service. If an operator applies a mask or another start
restriction during the update, OpenClaw retains the activated candidate and
reports a service-definition warning instead of rolling back because systemd
refused to start it. Gateway readiness is still unverified; remove the reported
restriction, run `openclaw gateway start`, then check `openclaw gateway status --deep`.
These checks belong to the installed updater; unmask before updating from an
older release too. See [Linux maintenance holds](/cli/gateway/service#linux-maintenance-holds).

Service membership uses the running Gateway's process ancestry and native supervisor
facts. An external terminal that inherited service environment markers can still update after native
membership is verified as external. Reparented children remain inside when they
share the Gateway's macOS process group or launchd job, or its systemd unit cgroup.
An already-current core update never refuses for service membership. When membership
cannot be verified as external, it completes with `already-current` and a warning
that plugin, runtime, and service maintenance was deferred, before that maintenance
can change files or stop the Gateway. An explicit channel change is also left
unapplied and named in the warning so it can be retried. Real updates retain the containment checks.
Present but unreadable native membership refuses with `service-membership-unverified`;
confirmed native membership uses `inside-gateway-service`. Windows currently uses
verified ancestry and the inherited-marker fallback because job-object membership
is not available to the runtime. A genuine Gateway descendant must use the managed
update handoff or an independent terminal.

Linux supports both cgroup v2 and the named systemd v1 hierarchy. When readable
native observations establish that this host has no service containment tree or
launchd job, a complete external ancestry walk and a distinct process group allow
the updater to stop, update, and start the managed service itself. The service
definition must still belong to this installation. The report and
`openclaw update status --json` record a warning: `Service membership unverifiable
on this host; using managed stop/update/start.`

Permission failures, conflicting, incomplete or malformed observations, and known service
members do not use this fallback. Reparented callers in the Gateway's process
group remain inside even when there is no native unit tree. When native facts
exist but cannot be read, run this sequence from an interactive external shell
not started by the Gateway service, under the installation's owning account:

```bash
openclaw gateway stop && openclaw update --yes && openclaw gateway start
```

Stopping the Gateway removes the live containment ambiguity. Keep the same account,
profile, and state/configuration paths throughout, and repeat any requested `--channel`
or `--tag` on the update command. If the update reports an error,
follow its recovery guidance before starting the Gateway. With native helper support,
`openclaw gateway call update.run --params '{}'`, the Gateway tool's `update.run`
action, and `/update` can instead perform a managed handoff. Linux transient user
handoffs require `systemd-run`; an emulated manager without it cannot use that route.
See [Automation and SSH](/cli/update#automation-and-ssh).

Managed-service refusals retain a specific code, such as
`inside-gateway-process-tree` or `service-definition-changed`, in the failure
report and `openclaw update status --json`. Shared reports preserve that code and
recovery guidance while removing private paths and process IDs. These checks run
in the installed updater: a new candidate cannot repair an older driver's refusal
before package replacement, or recover detail an older report already discarded.

Control UI updates use a verified helper to stop and restart the managed Gateway.
On macOS, the helper carries its live update ownership into LaunchAgent activation;
ordinary commands inside the Gateway still cannot stop their own service. If an
older installed updater reports `managed-service-stop-failed` before activation,
the candidate has not replaced that updater. Update from an external terminal
using the same installation owner, then retry the Control UI update.

After package replacement, compatibility config reads from older updaters run
in a fresh process using the updated package and its dependencies. This also
applies to updates driven by 2026.9.4. If an optional read fails, the updater
prints `candidate-config-read-failed` and leaves the service definition unchanged.
Reads follow the restored package after a rollback. Inspect the reported problem
with the updated CLI after the update.
Node and Bun readers run only one child per read. An attempted nested reader
stops before spawning and records `candidate-config-read-recursion`.
Both runtimes use the same result channel for synchronous and asynchronous reads;
config diagnostics stay separate from the result.

Bun-hosted updates from 2026.9.7 can finish candidate Doctor and restart the
Gateway after package replacement. Idle candidate workers release their IPC
references after native work closes, so a completed Doctor does not leave the
installed updater waiting indefinitely for its exit. This fix runs in the
updated package; the published updater and its handoff markers are unchanged.

The running Gateway retains its shutdown code before an in-place update can
replace the package's bundled files. Transcript shutdown drains captures and
persists deterministic notes without starting optional model inference. This
protection applies to updates **from** a release containing the shutdown fix.
Older running Gateways, including 2026.9.6, can still fail their first shutdown
with `ERR_MODULE_NOT_FOUND` after package replacement; installing a fixed
candidate cannot change code already running in that process. Start the updated
Gateway with its installation owner if the old process exits without restarting.

When a writable managed Node Gateway service points at another global installation,
the update keeps the active CLI's installation as its target and refreshes the
service through `gateway install --force` before verifying the restarted Gateway.
The old service command remains the recovery identity until that handoff succeeds.
Reconciliation failures are recorded as warnings with a manual repair command.
The code update can report success while service reconciliation remains pending;
a stopped service stays stopped until repaired. On Linux, regeneration preserves
the order of retained `PATH` entries and prepends newly added managed entries.
Paths carried over solely from the old definition still pass the existing safety
filters. If the definition cannot be preserved, reconciliation requires manual repair.
Deployment-owned definitions retain their existing installation owner.

An owned managed **Bun** Gateway at a different package root uses the existing
service-root update route: only the Gateway installation advances, and the
invoking CLI installation stays unchanged. The updater validates the service's
actual Bun executable against the Bun 1.4+ and WAL-safe `node:sqlite` requirements;
Bun's emulated Node version is not checked against `engines.node`. If the updater
runs on Node, its Node must also satisfy the target package's engine and SQLite
requirements before package replacement, because finalization uses that runtime.
Bun-owned package-manager checks and installs use that verified executable, and the
existing install/restart path retains the recorded runtime pin. A path under
`~/.openclaw` alone does not establish Bun package-manager ownership. See
[Bun-only installs](/install/bun-compatibility#bun-only-installs).

Doctor and `openclaw update repair` do not move a Bun Gateway onto a different
CLI installation. A repair invoked from that other installation reports the
drift and refuses service maintenance before stopping the Gateway. Run repair
from the Gateway's own installation, for example
`<bun> <service-root>/openclaw.mjs update repair`, or use `openclaw update` to
advance its installation in place.

The installed updater runs first. In a Linux split-root fixture, published
2026.9.6 refused early with `ENOENT` when Bun was absent from PATH, leaving the
Gateway and both installations unchanged. With the fork Bun on PATH, that
published driver updated the Gateway installation in place and restarted it
healthy while leaving the invoking CLI unchanged. The routing and explicit Bun
selection described above apply only when the updater driving the update
contains this fix. Installing a newer candidate cannot change that first hop.

Pending package-publication recovery in either the CLI or selected service
installation is checked before writable preparation. The updater settles eligible
lost-lease recovery automatically; other unfinished operations still require the
reported recovery command. Doctor does not clear those artifacts.

During an uninterrupted package update, the freshly installed private candidate
is checked by directory identity, package version, and launchers instead of
repeated full-tree scans. Content changes inside that private candidate during
publication are not detected. Its full fingerprint is retained for recovery;
resumed publication and repair still verify package contents. This optimization
applies when the installed updater contains it; older updaters keep their checks.

If a pnpm-owned install fails with `IO error: not a terminal`, the installed
updater may be triggering an interactive pnpm build-approval prompt while
capturing its output. A newer candidate cannot repair that first update.
Follow the [manual package-manager procedure](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun),
preserving the owning account, prefix, and state/configuration. Back up and stop
the Gateway through its actual owner before replacing the package. For the
installation step in a POSIX shell, supply noninteractive input:

```bash
pnpm add -g --allow-build=openclaw openclaw@VERSION </dev/null
```

Replace `VERSION` with a release containing this fix. Then run Doctor and restart
through the same owner as described in the manual procedure. Updates driven by
the fixed version supply noninteractive input to pnpm themselves. The recovery
command permits OpenClaw's own install scripts without approving additional dependencies.

The installed 2026.9.4 updater can refuse with `managed-service-preflight` before
the target code runs. To reach a release containing this repair, use the
[manual package-manager procedure](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun)
with the same owning package manager, prefix, and state/configuration. Back up
first, stop the Gateway through its actual supervisor or foreground process owner,
replace the package, run Doctor, and restart through that same owner.
`--no-restart` cannot repair the old admission check.

Updaters without the admission fix first shipped in 2026.7.2-beta.5, including
2026.6.34–2026.6.35 and the 2026.7.33–2026.7.35 extended-stable line, refuse before staging with
`plugins.load.paths: plugin path not found` when a configured plugin path is missing.
Restore the custom plugin directory or remove its configured path, then update.
`openclaw doctor --fix` repairs recognized bundled-path aliases but preserves unrelated custom paths.

<Note>
On macOS, the 2026.9.4 Gateway's `update.run` action or `/update` can hand off
successfully, then fail at activation with `managed-service-preflight` and
"This command is running inside the gateway process tree." The installed
updater refuses its own managed helper before swapping packages, so a newer
candidate cannot repair that first update.

For this ancestry refusal, the owner should run `openclaw update` once from an
independent Terminal outside the Gateway process tree, using the same owning
account, installation, and state/configuration. After installing a release
containing the managed-helper authority fix, subsequent updates started through
`update.run` or `/update` use the corrected updater. The fix applies to updates
**from** the fixed version; it does not repair the 2026.9.4 macOS handoff in place.
</Note>

Package updates that select Node inspect the exact candidate's Node requirement before activation.
An incompatible runtime produces `node-runtime-preflight`, with the target
version, required engine range, selected Node version, and an upgrade command.
npm directory permission failures produce `global-install-permission-denied`,
naming the directory, its owner when available, and the next action. Dry-run JSON
includes these outcomes in `failures`; the update report and Doctor's update
history retain recorded failures. The serving Gateway stays in place during
these preflight checks.

Directory permission checks remain in the **installed updater**. Older updaters cannot gain new
admission behavior from the candidate they have not staged yet. If upgrading
from an older release, check [Node requirements](/install/node) and the npm
prefix's permissions first; see [update troubleshooting](/install/update-troubleshooting#node-and-global-install-permissions).

<Note>
On FreeBSD, OpenClaw 2026.9.4 can stop before staging an update with
`managed handoff process start identity is unavailable`. Changing the target or
adding `--no-restart` cannot repair the installed updater.

For a pkg or Ports installation, update through pkg or Ports; do not overwrite
its files with npm. For an npm-owned installation, use the
[manual package-manager procedure](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun)
from a separate shell, with the same owning npm, installation prefix, and
Gateway state/configuration. Select a published version whose release notes
include the FreeBSD fixes; changes on `main` are not a published release.

Stop and start the Gateway through its actual supervisor or foreground process
owner around the manual replacement. This recovery does not add CLI-managed
FreeBSD rc.d service updates.

After an upgrade, check the [FreeBSD model-runtime limitation](/install/installer#install-clish) before starting agent turns.
</Note>

An already-installed registry package version or Git target SHA still runs plugin maintenance, repairs eligible old OpenClaw release pins, and restarts a running managed Gateway when plugins change or its service points at another installation, unless `--no-restart` is set. Unchanged runs finish as `skipped` / `already-current`.

Plugin maintenance does not fail an otherwise successful core update. If a plugin
cannot be updated, OpenClaw continues with the remaining plugins, keeps the previous
installation where possible, and prints a short next action. A running updated
Gateway can also report a plugin that did not load without turning the core update
into a failure. Individual plugin outcomes remain available in `--json` output.
When ClawHub has not published a version-matched official runtime plugin, the
updater tries its declared trusted npm source for that same version, honoring
catalog pins. Security and integrity refusals do not permit a source fallback.
If neither source can serve the release, a
compatible working installation stays in place with a version-skew warning and
an `openclaw plugins update <id>` retry instruction.

Unfinished plugin migrations retain their settings and state inputs while
`plugins install`, `plugins update`, `doctor --fix`, and `update repair` repair
the package. A verified replacement can be installed before its remaining data
migration completes; pending migration still guards runtime activation. Explicit
`config unset plugins.entries.<id>` can remove that entry, with the normal config
backup preserved. Removing the entry does not settle its pending data migration.

Failures to install core, repair required configuration or state, or start the
updated Gateway remain update failures, except for the service-definition refusals
described above.
Local copies selected through `plugins.load.paths` are operator-managed. Updates
and `openclaw update repair` retain the selected copy and any npm install it
shadows, and record a `plugin-operator-managed` warning in the outcome and update
history. Verify that copy against the updated OpenClaw version, or remove its
path from `plugins.load.paths` to use the managed installation again. This does
not grant the local copy trusted plugin privileges.
An explicit package artifact (for example, a tarball path or URL) is validated
and installed even when its version matches; matching versions do not prove
that two artifacts contain the same code.
An explicit `--channel` choice still becomes the saved update channel.
For versions that support checks before installation, health checks, config and plugin planning, and a
test Gateway boot on copied state finish before the service stops. The stopped interval
contains the swap, required migrations, plugin downloads and convergence, and
service start. Plugin work uses the installed target without requiring a serving
Gateway. A changed plugin snapshot runs fresh Doctor migrations before restart;
unchanged plugins do not run another full Doctor pass. The final report records
downtime through convergence and final verification, plus verification
results. See
[Validation and activation](/cli/update#validation-and-activation) for the checks.

Source updates also admit build-artifact ownership and runtime staging access in
the installed checkout before stopping the Gateway. A retained
`.artifacts/dist-artifacts.lock` refuses the update with the recorded owner,
timestamp, and exact recovery command while the serving Gateway stays running.
Verify that all associated build/check processes, including detached descendants,
have stopped before releasing that lock; a dead owner PID alone is insufficient.
The updater keeps that ownership until its work has settled and carries the
prepared runtime result into completion. Already-current repairs reuse the admitted
ownership; promoted runtime outputs do not need regeneration. Published updaters
that pass the source build-cache location, including 2026.9.6, also receive the
installed-checkout check during candidate builds.

The canary uses a temporary loopback Gateway port and suppresses background
listeners, including the MCP Apps sandbox, browser control, and channel services.
This lets validation run while the serving Gateway keeps its configured ports.
It preserves non-secret Gateway auth settings such as `gateway.auth.rateLimit`
for policy checks, while using a temporary token and disabling Tailscale identity
authentication.
The activated Gateway retains your normal listener settings. Candidate startup
progress is emitted only when the driving updater announces support, so older
updaters, including 2026.9.5 and 2026.9.6, retain actual startup errors instead of
mistaking a progress marker for the failure reason.
The internal progress-capable launch repeats the existing `--update-canary`
boolean marker; legacy launches contain it once. This is an internal
updater-to-candidate contract, with no operator configuration setting.
Startup failure reports retain the last meaningful stderr diagnostic and the end
of bounded log lines, with secrets redacted. Canary progress markers do not
replace the failure reason. The installed updater owns this reporting, so an
older updater can retain its earlier diagnostic behavior on the first update.
The canary verifies the copied plugin payloads without downloading replacements.
It warns when plugin refresh is deferred; live update finalization owns that
refresh, so a slow registry cannot consume the canary's startup budget.
This candidate-side behavior also applies when the installed updater is 2026.9.3.
That older updater still caps the entire validation sequence at five minutes;
its `--timeout` option cannot increase this cap.

Plugin rehearsal copies are temporary and rebuilt after interruption. Copying
uses up to four concurrent file copies and avoids a disk flush for every file.
If a copy fails, active copies finish before cleanup; link publication and
verification run only after all file copies succeed. Canonical state and recovery backups
retain their existing durability guarantees. An older installed updater keeps
its initial snapshot behavior until you launch an update from the newer version.

Runtime retention looks for hoisted dependencies within the package manager's
owning installation. Missing optional peers do not cause it to copy unrelated
ancestor installations. Explicitly linked dependencies retain their own resolution.
This improvement applies after the newer updater is installed; it cannot shorten
the retention phase already running in an older updater.

Database rehearsal also avoids a second full backup of each private snapshot.
Update schema inspection and rehearsal use SQLite online backup with a pinned
read transaction, so a busy Gateway can keep writing while the copy includes
committed WAL data. Each acquisition makes one copy instead of retrying until
the database becomes quiet. On rollback-journal volumes, SQLite can delay writer
commits until the consistent read finishes. Rehearsal records copied pages, bytes, and elapsed
time in the update ledger, then checks and publishes the private copy with row IDs
preserved for validation. Source databases and recovery backups retain their existing
protection; the faster preparation takes effect when the newer updater runs.

Package updates also check npm availability for enabled configured plugins before
stopping the serving Gateway or replacing the installed core. Registry targets
are checked early; explicit package artifacts are checked using the privately
staged package version before private validation, live-state preparation, or activation.
The check uses the same plugin version rules as post-update synchronization,
including release-cohort tracking, beta selection, and extended-stable targets.
A missing plugin version or registry error produces a warning naming the
affected plugin; the core update can continue. Registry-target `--dry-run`
includes those warnings. For explicit artifacts, `--dry-run` does not stage the
package and reports that plugin availability checking remains pending.
Extended-stable does not accept `--tag`. Bundled and path-installed plugins do not
require registry requests.

This metadata check does not reserve downloads. Plugin-only download, install,
or load failures remain actionable warnings after an otherwise successful core
update. Snapshot inventory runs from the staged candidate package, so it uses
the target version's plugin inspector. Snapshot inventory and candidate Doctor
share plugin source inspection. An unparseable entry produces a warning with the
plugin ID, source path, and parser error while its files are copied unchanged and
other entries are checked.
Valid ESM plugins can use `import.meta` during dependency inspection.
The updater preserves recorded choices and retains the previous plugin
payload where possible. Follow the reported `openclaw plugins update <id>` command for a
failed install or update, or `openclaw doctor --fix` for a load problem. Invalid
configuration or state, ownership errors, and failed core startup or readiness
checks still prevent completion.

### Package-publication recovery

Supported POSIX npm updates print a recovery command using the selected external
Node or Bun executable before
transferring the staged package into recovery custody. Keep the printed commands;
each names one operation with required `--anchor` and `--operation` arguments.
The initial journal and helper are published together in a private control
directory only after both are complete. A later update first prints a temporary
staging command, then the stable command after the helper has moved. The staging
command is valid only before that move; an earlier operation's command cannot
select a later operation. The helper verifies its own recorded path, identity
and content before using that journal. It is outside the live package and disposable recovery
directory. `status` reads the operation, `repair` resumes only its recorded
package publication, and `retire` removes only its recorded obsolete objects.
These commands do not replace post-update plugin, migration or service recovery.
Keep other package managers stopped while recovering the operation.

On FreeBSD, `repair` and `retire` read process identity through the recorded
installation's own `koffi` dependency: the live package, or the copy the
operation retains beside it during publication. Helpers written by older
updaters cannot repair or retire on FreeBSD; `status` still reports the
operation.

Bun recovery requires a supported Bun runtime with WAL-reset-safe SQLite and can
run without Node installed. The installed updater controls the first upgrade:
older releases may omit the recovery command on Bun or refuse a Bun recovery
runtime. Installing a newer candidate does not change that first-hop behavior;
subsequent updates use the candidate's recovery support.

Retirement records removal of the disposable directory before recording the
helper's final unlink intent. The helper is then removed. The bounded last
receipt remains in the control directory and is readable through
`openclaw update status --json` as `packageActivation`, even after helper removal.
A completed receipt is replaced only by a newly admitted update under current
ownership; it is not authority to mutate an installation. Historical filesystem
or executor-store identities do not have to match today's identities. Reboots,
remounts, or removal of already-retained evidence do not reopen a closed operation.
Reading a completed receipt does not rewrite it.
A new update archives the completed receipt before preparing its own operation,
preserving the journal and any leftover helpers or recovery directories as evidence.

Explicit repair preserves settled evidence, including the entire control journal,
inside the operation's retained recovery directory. The completed journal leaves
the active admission path, so an older updater does not need to understand a newer
settlement reason. Ordinary successful retirement retains the last receipt until the next update
archives it.
Explicit repair verifies an installed candidate under current executor ownership,
even when the old lease store disappeared or was replaced. It does not execute
the old helper, so a changed or missing helper and changed retained directories
are preserved as evidence rather than required as proof of the live package.
An unfinished rollback cannot be settled merely because its lease or installation
was replaced.

`openclaw update` uses the same settlement before admission
when the recorded lease database is missing or its identity has changed and the
live installation is still the recorded previous or candidate package. Candidate
content and launchers must pass verification. Settlement preserves recovery
evidence, reports a warning, and does not restart the Gateway or install a package.
`--dry-run` verifies and reports the planned settlement without changing the
journal, lease database, or recovery evidence. Other pending operations still
require `openclaw update repair` or the recorded package recovery command. The lease database stays at its existing location.

After the transaction verifies its selected installation, cleanup failures are
warnings. Changed old package trees, old helpers, and unexpected backup contents
are preserved, not restored or deleted. The updater durably closes their recovery
operation and attempts to archive the evidence. If completed evidence cannot be
archived, a later update retains it and uses the ordinary package-swap path without
standalone publication recovery. Its warning names that limitation.

These rules do not mark an unverified publication as a successful update. Missing,
legacy, corrupt, or identity-mismatched **unfinished** recovery artifacts still
require their recovery owner. Live ownership conflicts, changed selected packages
or launchers, and pending restoration remain refusals. Preserve those artifacts;
do not recreate the journal or remove them to bypass recovery.

These admission and cleanup fixes must be present in the updater executing them.
A newer candidate cannot run before an already-blocked older updater downloads it.
The candidate's dependency inventory can, however, avoid modifying old recovery
artifacts during an update that has already passed admission.

### Recover a completed receipt with an older updater

An installed 2026.9.8 or 2026.9.9 updater can reject a completed `anchor-retired`
receipt before downloading a fix when saved filesystem device numbers change.
Use a separately installed OpenClaw version containing the completed-receipt
recovery fix. Its standalone helper can archive completed history for the original
installation while that installation's Gateway keeps running:

```bash
node /path/to/recovery-openclaw/dist/package-update-activation-recovery.mjs \
  --anchor '/absolute/path/to/.openclaw.package-activation-<key>' \
  --operation '<recorded-operation-id>' status
node /path/to/recovery-openclaw/dist/package-update-activation-recovery.mjs \
  --anchor '/absolute/path/to/.openclaw.package-activation-<key>' \
  --operation '<recorded-operation-id>' retire
```

Use the anchor and operation ID from the original journal, with a supported
external Node or Bun runtime. Keep other updaters and package managers stopped.
`status` must report `complete`; it does not modify the receipt. `retire` acquires
fresh update ownership, verifies that the inspected completed receipt is still
current, and moves its control directory into the printed `.superseded-<id>`
archive. It preserves the journal bytes and saved identities, installed package,
launchers, and application state. It does not run Doctor or plugin migrations.
After successful archival, retry `openclaw update` using the original installation.

If archival fails and the active receipt remains, the command exits unsuccessfully
and names the next step. Preserve both the receipt and any existing archive while
resolving that error. An unfinished, foreign, or invalid operation still requires
its original recovery owner; the independent helper cannot authorize publication
or rollback for it. Do not rewrite identities or delete recovery artifacts.

### Unfinished publication and rollback

For an external-helper operation stuck at `prepared`, `publishing`, or
`publication-complete` whose live package already serves the candidate, run
`openclaw update repair` from an independent terminal. Repair verifies the
installed candidate's dist content inventory, manifest, launchers,
and current update ownership before settling the operation. It archives the
remaining helper and retained package evidence, including a changed previous
tree, without restoring or deleting that tree. Failed verification leaves
recovery armed and blocks the next update. Older updater versions without this
settlement path still require their original recovery owner.

SQLite recovery and rollback custody verify file identity, size, and content.
Timestamp-only changes are accepted after verifying identical bytes; replaced
files or changed database or journal bytes still require recovery by their owner.
Snapshot publication uses the same checks, including on older Linux kernels where
reported file creation time changes after ordinary writes or hard-link removal.

For older in-directory activation journals, `openclaw update status --json`
reports the recorded phase and the original helper's `status` command. The
current updater only inspects these journals; use their original helper to
recover or retire the operation before starting another update.

Package recovery does not replay a full-state checkpoint or reverse database
migrations. Automatic rollback keeps compatible databases in place, preserving
newer writes. If the previous runtime cannot read the current databases, the
updater retains the candidate and recovery artifacts and reports why rollback
was refused.

Rollback snapshots settle local SQLite writers under maintenance ownership before
capture, so writer shutdown during rollback is not mistaken for intervening writes.
The installed updater owns snapshot capture; staging a newer candidate cannot
change that behavior in an already-running older updater.

Switch channels or target a specific version:

```bash
openclaw update --channel beta
openclaw update --channel extended-stable
openclaw update --channel dev
openclaw update --dry-run   # preview without applying
```

`openclaw update` has no `--verbose` flag (the installer does). For diagnostics use
`--dry-run` to preview planned actions, `--json` for structured results, or
`openclaw update status --json` to inspect channel and availability state.

`--channel beta` selects the newest version by semantic version order from the
beta and latest npm dist-tags. Use `--tag beta` for a one-off package update pinned to the raw npm
beta dist-tag instead.

A saved `update.channel` remains the channel for future updates, automatic
checks, and update status. For example, a one-off beta package on a saved stable
channel keeps checking stable afterward. Use `--channel beta` to subscribe to
beta updates. Plugins still follow the installed core version where required
for compatibility.

`--channel extended-stable` is package-only, and installation remains
foreground-only. OpenClaw reads the public npm `extended-stable` selector,
verifies the selected exact package, and installs that exact version. Missing
or inconsistent registry data fails closed; it never falls back to `latest`.
If the selected version is older than the installed version, the normal
downgrade confirmation still applies. The CLI persists the channel after a
successful core update; a direct
`npm install -g openclaw@extended-stable --allow-scripts=openclaw` does not
update `update.channel`, but a final extended-stable package version still
checks only the verified `extended-stable` selector for update availability.
That direct command is for npm 12 or npm 11.16+. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`.
After the core swap, eligible official npm and trusted official ClawHub plugins with bare/default or
`latest` intent converge to that exact core version. Eligible older OpenClaw release
pins resume that default update policy. Explicit non-`latest` tags, independently
versioned pins, third-party plugins, custom ClawHub registries, and other sources retain
their existing behavior.
Version-bound runtime plugins converge to the base release cohort when the
core is a correction release (for example, `YYYY.M.P-2` uses plugin
`YYYY.M.P`).
`openclaw plugins update` uses the same host-matching targets. Known-incompatible
official runtime versions, such as Codex releases before 2026.9.7, are reported
as unavailable before they can register or serve turns. Compatible versions
remain loadable even when they are older than the host. Run
`openclaw update repair`, or `openclaw plugins update codex`, then restart the
Gateway. Newer explicit pins and independently versioned plugins retain their
existing compatibility behavior.
Catalog installs created by current OpenClaw versions retain that default
intent. Verified OpenClaw-owned packages recorded at an exact OpenClaw release
no newer than core resume their catalog's default selector after a successful
update. This includes old automatic and manual pins. Their recorded registry
and plugin settings are preserved, and subsequent updates continue following
the selected channel. A version explicitly supplied to a plugin update command
still applies to that operation.

`--channel dev` gives a persistent moving GitHub `main` checkout for npm-owned
package installs and existing Git checkouts. Package
installs reject the `--tag main` shorthand because the workspace checkout is
not a self-contained package artifact. Use `openclaw update --channel dev` to
switch to the supported checkout and build flow. Other explicit package specs
keep their package-manager behavior.

On source installs, Doctor and plugin updates keep plugins built with the host.
A registry plugin with the same version string can target a different SDK, so
it does not replace the source build without matching SDK build evidence.
Existing registry generations remain on disk; convergence reports the bundled
selection and skips their refresh. `OPENCLAW_DEV_SOURCE_ROOT` is not required.

Managed npm plugins on the beta channel use the same newest-of-beta/latest
selection, including official plugins such as `@openclaw/codex`. An older beta
tag cannot hold a plugin behind the current stable release. Startup repair
leaves already-current packages in place so a no-op refresh does not require
another restart.

See [Release channels](/install/development-channels) for channel semantics.

### Updating from 2026.9.2 across a schema bump

Updates driven by OpenClaw 2026.9.2 can cross a shared-state schema bump normally.
The target applies the migration content while retaining the old published
schema version, so the old updater can finish its ledger writes and final
report. Doctor explains that schema content is applied and version publication
is deferred. The new Gateway runs on the migrated content during this interval.

Publication waits until every affected update run has been terminal for at least
five minutes. A running row that has not changed for more than 30 minutes counts
as abandoned for publication purposes only; this does not terminalize an
identityless update-history row. The Gateway watcher publishes after the deadline;
a later database open can also publish it. See the precise timing and residual
old-CLI limitation in [Database schemas](/reference/database-schemas#schema-bumps-and-older-updaters).

When agent databases also need migration, the candidate first rehearses Doctor
on private copies while the published updater can still roll back its package.
After package commit, the fresh post-core process acquires current executor
authority and delegates Doctor. Doctor verifies a retained recovery archive
covering each agent database before migrating live state. The updater then
restarts the Gateway.

Missing state metadata or unverified backup coverage can still produce
`update-schema-bump-unfenced` with database versions and recovery instructions.
Before package commit, let the failed update finish restoring the previous
package. OpenClaw 2026.9.2 leaves the Gateway service stopped after failed
post-install verification. After package commit, the old package backup is gone:
finish `openclaw doctor --fix` with the installed compatible build, then run
`openclaw gateway start`. Package rollback cannot undo migrated state.

If the compatible package still needs installation, run
the manual update from a shell outside the Gateway, replacing `<target>` with
the exact target version from the refusal:

```bash
openclaw gateway stop
npm install -g openclaw@<target> --allow-scripts=openclaw
openclaw doctor --fix
openclaw gateway start
```

Run each command only after the previous one succeeds. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`. For a pnpm-owned install, replace the install
command with `pnpm add -g --allow-build=openclaw openclaw@<target>`; for Bun, use
`bun add -g --trust openclaw@<target>`.

Same-schema updates, earlier ledger-less updaters such as 2026.9.1, and fenced
transactional updaters from 2026.9.3 onward keep their existing behavior. The
fallback does not undo an earlier migration; if the database is already newer
than the restored package, install a compatible target and finish Doctor before
starting the Gateway.

For a Git checkout updated by 2026.9.2, a Doctor refusal before state writes
prints source recovery commands when the checkout's reflog identifies the
previous commit unambiguously. Wait for the updater to exit, then follow the
printed checkout, `pnpm install`, `pnpm build`, and service-start guidance from
an independent shell. If the previous commit cannot be verified, Doctor points
you to the reflog instead. A refusal after state repairs keeps the migration
owner's instructions: restoring source alone does not restore state.
These diagnostics also enter the warning log, subject to normal logging settings
and rotation. After resolving the refusal cause, retry the update. Once the
upgrade succeeds, subsequent updates check the new version before activation.

### From chat

Ask the agent to update OpenClaw, or send `/update` from Discord or another
connected chat. Natural-language requests use the existing `gateway` tool's
`update.run` action. The minimal, coding, and messaging profiles expose that update
action without granting configuration reads or other Gateway controls. Explicit tool
restrictions still apply.

Operator-created scheduled automations can also call `gateway` → `update.run`
without a chat owner identity. The Gateway uses the active scheduled run's
authority; a notification destination does not become its requester. Jobs created
by external chat users and webhook turns do not gain this authority. External
chat update requests still require current command-owner authority.

`/update` is the model-independent fallback: it works without a functioning model
or access to the `gateway` tool. The tool, slash command, and Control UI all use
the same Gateway update handler and current authorization checks.

The new version is checked while the old Gateway serves. An already-current
update restarts a running Gateway when plugins change or its service points at a
different installation. Update runs can send these notices in that chat as the
Gateway observes the recorded milestones:

1. An acknowledgement when the update is accepted.
2. `⏳ Restarting the gateway now (v<from> → v<to>)…` when activation is recorded before the Gateway stops.
3. `🔁 Back on v<to>, verifying…` when the new Gateway starts verification.
4. The final report, including successful updates.

External update and restart notices go to destinations listed in
`commands.ownerAllowFrom` or a linked administrator's direct conversation. The
channel resolves a direct recipient to its stable sender identity before checking
the administrator link; group and channel targets do not inherit a person's
administrator authority. Selecting a non-owner chat in the Control UI does not
authorize notices to that contact. If no owner destination resolves, OpenClaw
logs the skipped notice and keeps the update outcome in the run record and
Control UI; it does not redirect the notice to another chat or wake the rejected
session with diagnostics.

Update lifecycle notices also honor the destination account's `actions.sendMessage`
policy. An explicit account setting overrides the channel default; when neither
sets the flag, notices are allowed. Disabled sends are recorded as skipped notices
without preventing the update or its Control UI report.

Managed systemd or launchd updates can stop the Gateway before an intermediate
notice is delivered. The complete four-message sequence is not guaranteed for
those installations; the durable run report remains available after reconnect.

Runs with an internal origin session, including Control UI and webchat, receive
these notices directly in that session's transcript. Passing only `sessionKey`
is enough; the caller does not need to supply `deliveryContext`.
Before stopping the managed service, the updater waits for the serving Gateway
to finish its restart notice attempt. That wait is capped at 10 seconds so a
stalled notice cannot block activation.

The report includes the outcome, recorded phase durations, failed steps,
verification facts, and the next action when needed. Failed-step summaries preserve
the initiating cause ahead of trailing recovery advice, using recorded failure
facts when available. Local run history retains verification findings and backup
recovery paths separately from the excerpt. A run sends each notice at most once;
an update that stops before restart sends only the notices for phases it reached. If the update cannot
start, the bot records and explains why and provides the manual command when available.
The agent relays the returned recovery instructions to the operator. Manual
update commands run in a terminal outside the Gateway service; the agent must
not execute them in the shell of the Gateway hosting its session. A missing
owner permission requires owner setup, and an externally supervised installation
uses its deployment owner's update workflow.

For installations updated by OpenClaw itself, chat, CLI, Control UI, and automatic updates share a durable run ID.
Use `openclaw update status` to read the active or latest report, including after a restart; `--json` exposes the `activeRun` and `lastRun` records.
See [Run history and reports](/cli/update#run-history-and-reports) for Gateway history queries.

The sender must be in [`commands.ownerAllowFrom`](/tools/slash-commands#configuration)
or have a [verified channel link to a current Gateway administrator](/concepts/user-model#channel-identity-links).
Being allowed to chat does not grant owner permissions. If your account is not
an owner, the reply explains how the Gateway operator can connect it. Channel
setup and [pairing](/channels/pairing) distinguish owner access from chat access;
existing allowed users are not automatically promoted.
Chat updates retain the original authorization source across managed handoffs,
repair workers, and Doctor runs. Each worker checks the original installation's
current policy and profile state before acting. A repair worker's inference turn
checks them before each model attempt, each tool call and its effects, and
before it reports a result; its run-preparation checks verify update ownership,
the updater connection, and cancellation. Reassigning a channel account to
another administrator does not transfer an update already in progress; a current
owner must start a new update. Older updater handoffs without a captured profile
source retain their configured-owner checks and cannot acquire linked-profile
authority during recovery.
External-chat updates through `/update` or the tool require `commands.restart`
(enabled by default), including managed installations. The slash command also
follows command-access restrictions; tool calls follow tool policy. Chat updates use the hosting installation's
configured update channel and install method.
Agents must never run `npm install -g openclaw` or stop the Gateway service
from a chat shell; use `/update` or the update action so restart and notification
stay coordinated.

## Inspect FreeBSD service discovery

The standalone `scripts/freebsd-service-inspect.mjs` diagnostic reports which
`openclaw` rc.d definitions the native configuration selects. It requires a
root-owned Node installation, script, and shared discovery helper. It does not
require the OpenClaw Ports service package.

From an existing root shell, install the script from a trusted OpenClaw package:

```sh
install -d -o root -g wheel -m 0755 /usr/local/libexec/lib
install -o root -g wheel -m 0644 /path/to/openclaw/scripts/freebsd-service-inspect.mjs /usr/local/libexec/openclaw-service-inspect.mjs
install -o root -g wheel -m 0644 /path/to/openclaw/scripts/lib/freebsd-service-discovery.mjs /usr/local/libexec/lib/freebsd-service-discovery.mjs
(cd / && /usr/bin/env -i HOME=/ PATH=/sbin:/bin:/usr/sbin:/usr/bin LC_ALL=C /usr/local/bin/node /usr/local/libexec/openclaw-service-inspect.mjs)
```

Use your root-owned Node path if it differs. Clear the environment before Node
starts, as shown, to exclude Node preload options. The command accepts no arguments.
It reads native administrator shell configuration as root and requests no
service lifecycle operation. Administrator configuration is trusted shell code,
not a sandboxed data format.

The result includes the exact clean environment and working directory used for
discovery. It corresponds to `service` invoked with that same context. Configuration
that depends on another environment or directory can select different services.

The single JSON result reports `absent`, `present`, or `unknown`. Present results
include executable and non-executable definitions, their native search order,
and the first executable definition. Symlinks, unsafe ownership, incomplete
inspection, or unexpected configuration output produce `unknown` and exit 1.
Configuration contents and subprocess errors are not included in the result.

This is a diagnostic observation. It does not establish process or package
ownership, authorize an update, or enable CLI-managed rc.d service updates.
Continue to use the installation owner's update procedure above.

## Stale update history

Untouched, identityless legacy admissions older than 24 hours can
[expire automatically](/cli/update/status-and-history#run-history-and-reports)
during Gateway startup or a status check. The row is retained as `failed` with
reason `legacy-driver-expired` and retry advice; no explicit repair is needed
for that shape.

If update status stays in progress while the Gateway is healthy, check that no
update is still running. On the updated installation, run:

```bash
openclaw update repair
openclaw update status
```

For an inactive legacy row older than 30 minutes, repair verifies that the
running Gateway matches the installed version and build, then clears the stale
run without maintenance or a service restart. A new explicit `openclaw update`
can also supersede a single stale identityless row. Recent rows and recorded
live drivers are protected. Identityless rows outside the legacy-expiry shape
require explicit recovery; the Control UI's configuration-write suspension clears
after reconciliation.

Repair started within the owning update can continue with a matching inherited
run ID and live process identity; the run records that continuation. Repair
still refuses an unrelated live or stalled updater. The error identifies its
run, phase, driver PID, host, start and last-activity ages, and observed liveness.
Wait for that update to finish, or stop the named driver on its host and rerun
repair after it exits. See [Update repair](/cli/update/repair-and-recovery#update-repair)
for maintenance and recovery behavior.

OpenClaw 2026.9.2 does not reject a new CLI update because an older running row
exists: its [admission path](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/cli/update-cli/update-command-run.ts#L77)
creates a new run, and its [ledger](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/infra/update-run-ledger.ts#L250)
checks only for a duplicate run ID. Upgrade normally, then use the updated
`openclaw update repair` if the old history remains. A package-manager escape
is not required for this ledger defect. See [Update run history](/cli/update#run-history-and-reports).

## Retire update recovery data

Once you have verified the update and your conversations, preview retained
migration originals:

```bash
openclaw update cleanup --dry-run
```

Use the same profile and state/config overrides as the update, and check the
state directory printed in the report. The metadata-only preview can run while
the Gateway is active. To apply, stop that Gateway yourself, wait for other
SQLite maintenance to finish, and stop database readers such as session-listing
watchers. Keep them stopped until `openclaw update cleanup` exits; read-only
connections can change WAL/SHM sidecars and invalidate verification. Cleanup never
stops or restarts the Gateway. Confirmation defaults to **No**; automation must
explicitly pass `--yes`, including when using `--json`.

Cleanup permanently gives up rollback to eligible originals, including repaired
branches and old provider metadata. Current SQLite history, operator backups,
and protected or unknown artifacts remain. It is not a substitute for a
[pre-update backup](#before-updating-create-a-verified-backup). See
[Update cleanup](/cli/update#update-cleanup) for eligibility, JSON output, and
resuming interrupted deletion.
Private package, command-shim, and Git runtime backups remain owned by the update
transaction and are outside this migration cleanup. An interrupted entry in update
history does not block cleanup of otherwise eligible migration archives.

## After updating

Successful managed `openclaw update` runs already restart and verify the Gateway.
Use these steps after a manual installation or when checking a reported problem.

<Steps>

### Run doctor

```bash
openclaw doctor
```

Migrates config, audits DM policies, and checks gateway health. Doctor also compares active official plugins with the OpenClaw package the managed service will load after restart. Resolve any plugin restart-readiness warning before continuing. Details: [Doctor](/gateway/doctor)

If you use the unpacked Chrome extension, also run `openclaw browser doctor --browser-profile chrome`.
For a version-mismatch warning, reload the extension from `chrome://extensions`;
fully restart Chrome if the warning remains.

### Restart the gateway

```bash
openclaw gateway restart
```

### Verify

```bash
openclaw health
```

</Steps>

### Background exec notifications after an update

`[OpenClaw exec completion]` identifies an automatic follow-up for a background
command, rather than a recurring heartbeat poll. These follow-ups can run with
`agents.defaults.heartbeat.every: "0m"`. To keep background exec without these
extra model calls, set `tools.exec.notifyOnExit: false` and check per-agent
overrides at `agents.entries.<id>.tools.exec.notifyOnExit`. Use `process poll` to
collect results. See [Background exec notifications](/gateway/background-process#disable-automatic-completion-turns)
for when the setting takes effect.

<a id="rollback" />
<a id="roll-back-a-package-install" />
<a id="roll-back-a-source-checkout" />
<a id="downgrading-across-the-session-sqlite-migration" />
<a id="restore-state-only-when-necessary" />
<a id="verify-the-rollback" />

## Detailed topics

<CardGroup cols={3}>
  <Card title="Other update methods" href="/install/updating/update-methods" icon="shuffle">
    Switching between npm and git installs, source servers, the installer, and manual package managers.
  </Card>
  <Card title="Automatic updates" href="/install/updating/automatic-updates" icon="clock">
    The auto-updater, per-channel behavior, and update campaigns.
  </Card>
  <Card title="Rollback and recovery" href="/install/updating/rollback-and-recovery" icon="rotate-left">
    Downgrades, automatic rollback, pre-update backups, and triage.
  </Card>
</CardGroup>

- <a id="switch-between-npm-and-git-installs" />[Switch between npm and git installs](/install/updating/update-methods#switch-between-npm-and-git-installs)
- <a id="source-checkout-servers-(reference-script)" /><a id="source-checkout-servers-reference-script" />[Source-checkout servers (reference script)](/install/updating/update-methods#source-checkout-servers-reference-script)
- <a id="alternative%3A-re-run-the-installer" /><a id="alternative-re-run-the-installer" />[Alternative: re-run the installer](/install/updating/update-methods#alternative-re-run-the-installer)
- <a id="alternative%3A-manual-npm%2C-pnpm%2C-or-bun" /><a id="alternative-manual-npm-pnpm-or-bun" />[Alternative: manual npm, pnpm, or bun](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun)
  - <a id="package-lifecycle-and-operator-state" />[Package lifecycle and operator state](/install/updating/update-methods#package-lifecycle-and-operator-state)
  - <a id="advanced-npm-install-topics" />[Advanced npm install topics](/install/updating/update-methods#advanced-npm-install-topics)
    - <a id="read-only-package-tree" />[Read-only package tree](/install/updating/update-methods#read-only-package-tree)
    - <a id="hardened-systemd-units" />[Hardened systemd units](/install/updating/update-methods#hardened-systemd-units)
    - <a id="disk-space-preflight" />[Disk-space preflight](/install/updating/update-methods#disk-space-preflight)
- <a id="auto-updater" />[Auto-updater](/install/updating/automatic-updates#auto-updater)
  - <a id="update-campaigns" />[Update campaigns](/install/updating/automatic-updates#update-campaigns)
- <a id="downgrade" />[Downgrade](/install/updating/rollback-and-recovery#downgrade)
  - <a id="automatic-checkpoint-recovery" />[Full-state recovery requires a backup](/install/updating/rollback-and-recovery#automatic-checkpoint-recovery)
  - <a id="automatic-schema-neutral-rollback" />[Automatic schema-neutral rollback](/install/updating/rollback-and-recovery#automatic-schema-neutral-rollback)
  - <a id="before-updating%3A-create-a-verified-backup" /><a id="before-updating-create-a-verified-backup" />[Before updating: create a verified backup](/install/updating/rollback-and-recovery#before-updating-create-a-verified-backup)
- <a id="if-you-are-stuck" />[If you are stuck](/install/updating/rollback-and-recovery#if-you-are-stuck)
  - <a id="unattended-repair-on-your-own-inference" />[Unattended repair on your own inference](/install/updating/rollback-and-recovery#unattended-repair-on-your-own-inference)

## Related

- [Install overview](/install): all installation methods.
- [Doctor](/gateway/doctor): health checks after updates.
- [Migrating](/install/migrating): major version migration guides.
