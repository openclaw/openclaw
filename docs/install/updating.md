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

After a Mac app update, recovery checks the service selected by the connection
mode: the local Gateway or, with a remote primary, the Mac node service. If a
custom node launcher cannot be inspected, check its node LaunchAgent before
retrying. This node inspection failure does not invalidate an already verified
local Gateway. Recovery keeps the update receipt for retry, verifies the node
after its launcher is repaired, and leaves the custom launcher unchanged.

For [standalone builds](/install/standalone#update-the-complete-artifact), update
the owning desktop app or replace the complete executable and runtime directory.
The standalone CLI refuses package-manager and git updates with a visible next
step; mixing artifacts from different builds is unsupported.

For Docker, Podman, and Kubernetes image replacements, see
[Upgrading container images](/install/docker#upgrading-container-images). The
image entrypoint runs Doctor before starting the Gateway and exits if mounted
state cannot be repaired safely.

Before upgrading, follow the [preflight checklist](/install/updating/rollback-and-recovery#before-you-upgrade).
Before a significant update, [create a verified backup](#before-updating-create-a-verified-backup).
Automatic config copies and migration recovery originals are not a full-state
backup.

## Update implementation contract

Candidate Doctor preserves same-conversation automation continuations when adopting
a stored inference account. It carries forward the original authenticated source
only when its old executable revision still matches, then binds that source and
existing standing-grant references to the restricted definition. Stale captures
stay stale; runtime authorization, conversation identity and revocation checks
remain required. The candidate must contain this repair.

Background discovery failures are logged and retried at the next scheduled check.
Gateway shutdown cancellation stays quiet; unexpected scheduled task failures
are reported by the scheduler without restarting the Gateway.

**Updates always work** (`openclaw update` finishes best effort everywhere). Changes to update, Doctor, service lifecycle, migrations, plugin loading: state their update behavior. Installed updater runs first, can't be patched; candidate fixes key on markers shipped drivers set; existing operator state = input. Recoverable hiccups → recorded warnings; back up before mutating, let rollback restore it; refuse only for named data risk with previous Gateway kept running. Timeouts and budgets: generous, derived from measured state, sized for slow hardware. Proof: published-driver × candidate cell.

Update inspection and snapshot workers bind plugin metadata discovery to the
selected installation's state directory, including requests from older installed
updaters. A different profile's database version must not block that inspection.
The candidate worker must contain this repair; an older updater inspecting with
its own worker still needs an updated runtime.

Private Doctor and post-core workers validate command fields before entering maintenance.
The delegated executor admits its grant data separately and still checks live process and
installation ownership before effects. Callbacks and live deadline objects stay in the
initiating process; only serializable options cross the migrated-update handoff.

Stopped update and Doctor database snapshots tolerate concurrent read-only SQLite
probes. The transient `-shm` WAL index is rebuilt privately, never copied or used
to detect durable changes. Empty WAL files created by readers count as absent.
Changes to the main database, WAL data, or rollback journal still refuse the
stopped backup and identify the changed file. This repair must
be present in the runtime performing the snapshot, including the candidate worker
when the installed updater delegates capture to it.

Candidate Doctor also accepts an empty WAL index appearing or disappearing
between an older updater's capture and migration admission, provided the database
identity and committed contents still match and the index contains no write
evidence. This preserves the installed updater's original fingerprint format.
Changed committed data or write evidence still refuses migration and automatic
restoration. The candidate must contain this repair.

Within one database-generation observation, update and Doctor workers reuse a
verified digest while the file's device, inode, size, and nanosecond birth,
modification, and change times remain identical. Each family observation still
checks the database, WAL, and rollback journal; private-copy verification and
WAL commit checks remain in place. Changed or unavailable identities require
hashing again. Reuse ends with that observation and does not cross Doctor
invocations. Reuse also requires nanosecond bigint stat fields and modification
and change times more than two seconds older than the start of hashing. Recent
writes can share a coarse filesystem timestamp even when nanosecond fields are
available, so their digests are recomputed. Millisecond-only stats never enable
reuse. The runtime performing the observation must contain this change;
a newer candidate cannot change an older installed updater's own reads.

Update snapshots and database backups accept a database whose only integrity
findings are `malformed inverted index` reports on canonical, schema-validated
agent FTS tables. A Node upgrade that changes SQLite tokenization (for example,
SQLite 3.54) produces exactly these findings on an intact database, and the
runtime that next admits the copy rebuilds the indexes. The copies keep the
original index bytes, so rollback to the previous runtime restores its own
index. Unknown FTS definitions and findings mixed with any other damage still
refuse the update. The candidate performs the rehearsal snapshot, so this applies
from the first update to a candidate with the fix; activation-time backups need
the installed updater to contain it.

Memory embedding migrations space maintenance renewals from the completion of
each renewal, so slow renewals leave time for conversion work. The candidate must
contain this fix; it does not change an older migration already running.

On macOS, reinstall and uninstall reconcile the launchd registration by service
label even if its plist was deleted. Reinstall warns when the previous definition
is missing; an existing plist and its private environment files remain backed up
for rollback if activation fails.

Update-time service reconciliation also removes the historical macOS
`NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem` setting when the candidate installer retires
it. This requires the candidate to contain the repair and the installed updater
to delegate service refresh to that candidate. Custom CA bundles at other paths
remain preserved, and unknown operator edits still require manual repair.

For existing managed Gateway and node-host services, migration makes a one-time,
best-effort copy of eligible operator CA additions into
`<state directory>/service-ca/<service label>-operator-ca.pem` (mode `0600`).
It reads the installed service's effective CA setting, so its custom trust need
not be present in the updater shell. A distinct CA bundle already selected by
the service remains preserved when the installer does not explicitly select a
different bundle. An explicitly selected distinct bundle takes precedence.

Automatic eligibility is deliberately narrow: the legacy file must retain the
complete, byte-identical historical OpenBSD `1.22.2.1` stock prefix (333483 bytes,
SHA256 `9dae8d76e55cb08991f2b672d58999ea15560d910759c16b544f843bdffbb994`),
as observed in Apple's sealed macOS 27.0.1 template, followed by appended PEM
certificates. Only appended self-signed CA roots with recognized clean native
trust results are eligible. Self-signature alone does not establish provenance.
Stock keys, known compromised keys and any explicit macOS distrust are excluded,
including alternate certificates with the same public key. Native checks include
user, administrator and system trust settings and offline Basic X509 evaluation.
Other stock revisions, replaced or reordered bundles, intermediate-only additions,
unknown native results and unresolvable distrust require manual review.

Migration never changes `/etc/ssl/cert.pem` or overwrites a conflicting operator
file. The CLI reports successful, unnecessary, ambiguous or failed migration,
including partial migration where some additions cannot be established as
eligible. Ambiguity, unavailable provenance or a write failure does not block
the update: the obsolete override remains retired, and dependent private HTTPS
or WSS connections may stop working. Review the guidance before relying on
automatic recovery. Previously working connections that require compromised
keys intentionally remain rejected.

After migration, rotate legitimate private CAs in the maintained bundle and
restart the service. OpenClaw does not synchronize future changes from the
retired file or continuously rescreen this operator-owned bundle against OS
trust changes. For manual recovery, create a distinct maintained PEM bundle,
select its absolute path with `NODE_EXTRA_CA_CERTS`, then run
`openclaw gateway install --force` or `openclaw node install --force` from that
environment. Never restore the entire obsolete stock bundle
or disable certificate verification to recover connectivity.

When reconciliation replaces the service's Node executable, its leading runtime
directory in `PATH` can move to the selected Node directory. Every other existing
`PATH` entry must remain in order; this does not discard custom directories.

When an updater stops a macOS LaunchAgent, it waits for both launchd's process
and the verified serving Gateway child to exit before continuing. An unloaded
job or a closed listener does not prove that the child has released its agent
databases. Pending process cleanup produces a warning and shares the existing
bounded stop deadline; other processes using the state still receive Doctor's
maintenance refusal. The updater performing the stop must contain this fix.

Candidate state workers drop advisory progress when stderr is temporarily full.
Dropped writes do not consume the legacy progress budget, so reporting resumes
when the pipe becomes writable. The worker must contain this repair; it does not
change an older worker that is already running.

Package verification checks file hashes, sizes, and required executability. When
a non-executable dist file gains execute bits, verification continues with one
warning listing the affected file count, provided it has no group/world write or
setuid/setgid/sticky bits. Other permission differences retain their existing
behavior, including owner-only recovery modes. File permissions are left
unchanged. Missing required executability, changed content, and unsafe file types
still fail verification. The installed updater must contain this fix; a newer
candidate cannot change an older updater's package verification.

Supervisor-managed migrations also validate Doctor's repairable projection before
rejecting retired config fields such as `agents.defaults.heartbeat`. They preserve
the original config and database backups before Doctor migrates the state and
converts heartbeats to Automations. Unknown keys and invalid heartbeat settings
still refuse admission. Repeating the migration preserves the converted jobs and
does not repeat the heartbeat delivery notice.

Before replacing a Git checkout's build or an installed package, the updater
retains its running runtime. Late module imports and background workers keep
using that generation through finalization, rollback, and CLI cleanup, even when
the new build has different chunk filenames. The new Gateway starts from the
activated build.

This retention covers Node and Bun late imports, including CommonJS dependencies
and JSON. Module state already loaded by the updater stays shared through cleanup;
imports outside that retained generation continue using the active installation.

Source updates qualify the installed pnpm launcher outside the checkout so even
its version probe cannot rewrite the checkout's lockfile. If another version is
needed, the updater uses a temporary Corepack shim or npm-installed pnpm matching
the checkout's pin. This requires the installed updater to contain the fix;
staging a newer candidate does not change an older updater's initial probe.

Candidate pnpm installs use a project-local virtual dependency graph while
reusing the configured package store. This also applies when pnpm uses hoisted
links: pnpm 12 can otherwise materialize unpatched package bytes from a global
graph despite recording a patch hash. After source exposure changes dependency
topology, the updater refreshes bundled plugin links before final candidate
validation. The refresh links the packages it finds in each plugin's
`node_modules`. A link whose target is missing produces a warning and is skipped
when the plugin declares that package optional; any other broken link or
filesystem error stops preflight. The refresh does not check for dependencies
that were never installed.
These preparation changes require the installed updater to contain the fix;
staging a newer candidate cannot change an older updater's initial install.

Native pnpm package swaps preserve platform-filtered optional dependencies as
absent. On Windows, a dangling link declared in its owner's
`optionalDependencies` is removed from the staged copy instead of failing
activation; missing required dependencies and other filesystem errors still
fail. This requires the installed updater to contain the repair. A failed swap
before any installation or service mutation records the previous Gateway
observation without restart verification, including with `--no-restart`.

Source candidates bound the native declaration compiler with the shared Go runtime
policy used by local checks. Node's heap limit does not cover that compiler.
Explicit `GOMEMLIMIT`, `GOGC`, and `GOMAXPROCS` tuning remains in effect.

Managed update helpers route diagnostic logs to stderr so debug logging cannot
interrupt their control handshake. This applies to the installed updater; a newer
candidate cannot change an older updater's pre-activation handshake.

If native service inspection becomes unavailable after admission, the updater
refuses activation before stopping the Gateway or replacing its package. When
inspection is unavailable initially, a live or unverified Gateway state owner
also blocks package replacement, even if the process title no longer contains
its installation path. The refusal leaves the installation unchanged and names
the service inspection and stop commands to use before retrying.

Before stopping a managed Gateway, the updater waits up to 30 seconds for foreign
SQLite maintenance to finish. If it remains busy, activation is deferred and the
Gateway stays running. Recovery checks after shutdown use the same bounded wait;
if maintenance still does not finish, the existing rollback path restores the
previous build. The refusal names the maintenance process and tells you to let
it finish before retrying `openclaw update`. An explicit update timeout and
cancellation still bound these waits; live ownership and recovery checks remain
required before activation.

The updater retains its admitted SQLite writer wait allowance through finalization,
including candidate handoff and standalone repair. A writer that outlasts SQLite's
ordinary wait can finish before required recovery evidence and the final outcome
are recorded. Optional history bookkeeping still uses its short wait and warns
without stopping the update. This applies to the installed updater; the candidate
also preserves the step allowance passed by older installed updaters.

`openclaw update status` reports confirmed driver loss without changing the
recorded run, and names `openclaw update repair` as the next action. Repair or the
next update's admission can record the failed outcome without waiting for the
inactivity grace period. Live or unverifiable drivers and retained recovery
continue to preserve their ownership.

A successful foreground update hands completion to the replacement Gateway.
Automatic history reconciliation preserves that handoff while startup verifies
the running build. If the replacement never starts, `openclaw update repair`
can recover the abandoned handoff explicitly.

Handoff repair uses recorded boot sessions and process creation times to exclude
prior-boot families and unrelated processes with reused parent PIDs. On Windows,
a legacy handoff without a boot identity also qualifies as prior-boot when its
durable write is more than five minutes before the current boot started. Unverified
descendants and incomplete process censuses block settlement to prevent overlapping
updaters. Positive handoff descendants, OpenClaw identities, and retained-runtime
path holders also block repair. This does not relax Doctor's artifact-custody
checks or remove retained recovery data.

Authenticated readiness probes recheck the update's live ownership before opening
their transport and sending RPC frames, including deferred authentication and
startup retries. Losing ownership stops those probes.

If the retained verifier cannot authenticate to the restarted Gateway, it stops
retrying that rejection. Local HTTP readiness and runtime version/build identity
can verify activation instead, with an RPC authentication warning recorded in
the update result. This does not change Gateway authentication or pairing.
The retained verifier runs the previous package, so an update that changes the
Gateway protocol version, in either direction, gets the same HTTP identity check
with an RPC protocol warning instead of waiting for an RPC handshake that cannot
succeed. When readiness never settles, the recorded timeout names both the read
the budget interrupted and the last health probe error, such as an RPC
rejection.

Channel outages are warnings once the expected Gateway build is running and its
core readiness is verified. Detailed `/readyz` responses report `coreReady`
separately while preserving HTTP 503, `ready: false`, and failing channel names.
Update history retains those channel and HTTP facts. Startup, state and agent
database admission, child-runtime, and plugin-replacement failures still prevent
core readiness; an older HTTP 503 without explicit core proof remains unverified.
Run `openclaw channels status --probe` to investigate channel warnings. This
requires the repaired installed updater; a new candidate cannot change the
checks of an updater already running.

After a Doctor child settles, the updater drains its retained handles for the
affected shared-state database and revokes their schema admission, even when
Doctor exits unsuccessfully. The next parent access admits the resulting schema
again and refuses a version newer than the running updater supports.

After Doctor backs up and admits shared-state maintenance reads, native Codex
assignment detection reads one database transaction snapshot. Lease renewals and
other maintenance writes can continue without requiring the database files to
stop changing for a private copy. Inspection without that admission still uses
an artifact-preserving copy and refuses an inconsistent source. This is
candidate-side behavior; the installed updater runs first with its shipped checks.

During update finalization, disposable plugin source copies and private SQLite
inspection snapshots use the candidate helper's absolute `TMPDIR` (including
when an older installed updater starts that helper). Normal Gateway cache
placement is unchanged. Installed plugin projects, retained native admissions,
and recovery or migration backups remain with their existing durable owners;
`TMPDIR` does not relocate those writes or remove the need for free space on the
installation and state filesystems.

Plugin source capture repairs stale dependency links without changing real
dependency directories. POSIX replacements are staged before publication;
Windows removes only the junction or symlink before recreating and verifying it.
A failed link leaves that plugin unprepared with a named error. Doctor retains
its pending migration obligation while other plugins' migrations continue.
This repair applies when the candidate loads plugin contracts during Doctor.

### Migration integrity checks

SQLite upgrades default to a whole-database `quick_check`, a full
`integrity_check` of the tables the migration rewrites or re-indexes, and the
existing foreign-key checks. This avoids checking every unrelated index against
its table during a routine upgrade. Structural corruption anywhere in the
database and corruption in the migration's affected tables still refuse the
migration; quarantine and rollback behavior are unchanged.
Historical upgrades use the same default even when recovery requires a full-file
backup. Automatic original-state captures and disposable update rehearsals also
honor the requested check, including same-version Doctor repairs. Automatic rollback
images, restore validation, explicit Doctor recovery, and legacy transformed recovery
archives retain full integrity checks.

To request full integrity checking across every table and index during migration:

```bash
openclaw update --full-integrity-check
openclaw doctor --fix --full-integrity-check
```

The default can miss an index/table mismatch in an untouched table. Use the full
check when you need that coverage; it can take considerably longer on large
databases. A successful quick check is never recorded as a full verification.
Later runtime admission still performs a full check when no reusable
full-verification seal exists, and can detect that mismatch before activation.
The flag selects migration checks; it does not turn an already-current database
into a separate verification job. Explicit database verification, backup
verification, Doctor recovery, and compaction retain their existing checks.

The installed updater runs first. Its own captures and checks keep their shipped
behavior; the more efficient default begins when the candidate runs its
migrations. An older installed CLI does not recognize the new flag. For that
first upgrade, update normally to receive the candidate's new default, or run
the candidate's `doctor --fix --full-integrity-check` through your manual upgrade
workflow.

Post-activation schema verification preserves agent databases Doctor holds after
deletion. These stores may keep an older schema without failing the update;
Doctor's held-store warning remains visible. Configured agents required by the
Gateway must still pass runtime admission: Doctor fails if a recovery hold
leaves a required store unusable. Active databases and pending deletions require
the candidate schema, and held stores remain part of rollback verification.
Retained plugin databases, including plugin shared-state stores, are not checked
against the agent schema. Their plugin owns migration; they remain in the
snapshot and rollback inventory even when the plugin is disabled. The primary
shared-state database is checked against the shared-state schema.

The local client credential cutover preserves private identities and cached tokens
in `client/credentials.sqlite`, separate from shared Gateway state. The preparatory
release does not create that file. Earlier SQLite drivers capture the shared
credential tables before the cutover and restore them on automatic rollback; the
old version ignores the remaining local file. Credentials issued between upgrade
and rollback are lost, and those clients must pair again. A later upgrade rebuilds
that stale local file from restored shared state instead of merging it. PostgreSQL
installations use an engine-aware driver with local-family capture support, so
rollback restores the shared and local stores together. See
[credential migration and recovery](/reference/database-schemas/versioning#local-client-credentials).

Updates started by 2026.10.4 keep the client credential store's independent
schema out of the older updater's agent-schema check. Credential-aware updaters
verify that store against its own schema, and both paths retain its backup and
recovery coverage.

Independent native credential sources remain unchanged during import and remain
readable by the previous app after rollback. Reusing the same source preserves
local refreshes; a changed or restored source rebuilds its local copy while
retaining consumed legacy-JSON claims.

OpenClaw.app runs plugin convergence through the selected runtime's Doctor while
the app owns Gateway activation. This aligns managed official npm plugins with the new
core before plugin migrations, repairs host peer links, and refreshes the plugin
registry. Unavailable replacements remain nonblocking: the app's recovery
diagnostics include the remaining version or peer-link warning and the exact
repair command. Retry Gateway setup in the app to repeat this owned repair.

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

Current Doctor can migrate pre-July cron jobs, Voice Wake settings, conversation
bindings, and OAuth credentials directly. It archives obsolete delivery queues,
plugin indexes, sandbox registries, and runtime notifications, preserving original
bytes and reporting recovery instructions. Run `openclaw doctor --fix`; these JSON
formats do not require an intermediate release. See [Doctor state migrations](/cli/doctor/state-migrations).

The following bridge instructions apply to other retired formats and config keys.

For installations older than July 2026, upgrade to **`2026.9.5` first**, run its
Doctor migrations, and then upgrade to `latest`. The bridge release still
imports the old `tasks/runs.sqlite`, `flows/registry.sqlite`, and
`plugin-state/state.sqlite` databases and pre-June plugin JSON state, repairs retired agent and channel
config keys, and
includes the old runtime aliases. The retired plugin imports cover Telegram,
iMessage, Active Memory, Nostr, and Microsoft Teams; see
[legacy state migration](/cli/doctor/state-migrations). Current releases leave
those retired state files untouched.
If you already installed the latest version, Doctor stops before rewriting config
that still contains these retired keys and directs you through the same bridge.

The retired same-file memory index (`meta`, `files`, and `chunks`) is also refused
before current tables are created. Preserve the original state and configuration,
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
Install the affected plugins before running their migrations.
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

Service backups and interrupted agent cleanup also retain exact file identities.
Older rounded receipts remain readable and upgrade after verification on their next write.

Post-install Doctor also accepts older updaters, including `2026.8.2`, that do not
provide an update run ID. Its commands retain invocation-specific custody without
requiring an environment-variable workaround.

Doctor keeps a command's captured birth identity through native custody binding.
If a command finishes before that identity can be captured, its original spawning
owner still joins the command and confirms its process group has exited before
releasing the reservation. A live or unreadable command remains protected.

When the installed `2026.9.2` updater runs the candidate's early Doctor check,
shared-state and agent schema changes are rehearsed on private copies. Plugin
inspection cannot publish native admission metadata to live state during this
check. A refused rehearsal leaves live database schemas unchanged for package
rollback; successful checks defer migration to the fresh post-core updater.

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
On macOS, verified external launchd membership is sufficient even when a root-owned
`login` process prevents a complete ancestry walk, including in integrated terminals.
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

Package-swap reports distinguish `package-recovery-permissions-unsafe` (recovery
artifact permissions or link count) from `managed-handoff-lease-identity-changed`
(a recorded lease database path, file, or parent directory changed). Shared
reports retain these closed reason codes while redacting private diagnostics.
Other package failures keep the `global-install-failed` reason. These diagnostics
do not change refusal, backup, or rollback behavior and require an updated driver.

Generated failure reports name recognized candidate startup causes, including
plugin loading, port conflicts, schema migration, native-module compatibility,
readiness timeouts, and process signals. Plugin names appear only when they belong
to the shipped public catalog. Config errors retain schema field names and fixed
validation kinds; user-defined map keys become `<id>` and unknown keys become
`<key>`. Arbitrary error text and rejected values stay out of public reports.

Control UI updates use a verified helper to stop and restart the managed Gateway.
On macOS, the helper carries its live update ownership into LaunchAgent activation;
ordinary commands inside the Gateway still cannot stop their own service. If an
older installed updater reports `managed-service-stop-failed` before activation,
the candidate has not replaced that updater. Update from an external terminal
using the same installation owner, then retry the Control UI update.

After package replacement, compatibility config reads from older updaters run
in a fresh process using the updated package and its dependencies. This also
applies to updates driven by 2026.9.4. If an optional read fails, the updater
prints `candidate-config-read-failed` with the reader's error or exit reason and
leaves the service definition unchanged. The reader's stderr is not echoed.
Reads follow the restored package after a rollback. After the update finishes,
inspect the reported problem with the updated CLI, then run
`openclaw gateway install --force` with the same `--profile` or `--dev` option as
the update to refresh the service definition.
Node and Bun readers run only one child per read. An attempted nested reader
stops before spawning and records `candidate-config-read-recursion`.
Both runtimes use the same result channel for synchronous and asynchronous reads;
config diagnostics stay separate from the result.

Bun-hosted updates from 2026.9.7 can finish candidate Doctor and restart the
Gateway after package replacement. Idle candidate workers release their IPC
references after native work closes, so a completed Doctor does not leave the
installed updater waiting indefinitely for its exit. This fix runs in the
updated package; the published updater and its handoff markers are unchanged.

After a native service starts, restart preparation allows its verified process
up to the normal startup deadline to replace missing or dead Gateway ownership
before signaling it. This avoids an intermittent `restart-unhealthy` result when
an older updater starts the updated service before asking the new installation
to restart it.
The fix runs in the new installation, so it also applies to the next update
from 2026.8.35. Missing ownership after the deadline and unrelated process locks
still refuse the restart.

The running Gateway retains its shutdown code before an in-place update can
replace the package's bundled files. Transcript shutdown drains captures and
persists rule-based notes without starting optional model inference. This
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
actual Bun executable against the Bun 1.4.3+ and WAL-safe `node:sqlite` requirements;
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

pnpm updates use the installation's own pnpm home and bin directory, even when
macOS service PATH excludes pnpm or a version manager puts another pnpm first.
Both pnpm 10's home-level shim and pnpm 11's `bin/` shim are supported, and the
child PATH includes both locations. The installed updater must contain this fix;
installing a newer candidate cannot repair an older updater's preflight.

Native pnpm updates also relocate pnpm 12 launcher paths before publishing them.
After activation, unresolved launcher targets produce a warning with repair
guidance without rolling back the updated package. These protections require
the installed updater to contain the fix. If an older updater left `openclaw`
pointing into a missing `.openclaw-update-native-*` directory, reinstall the
same version with `pnpm add -g --force openclaw@<installed-version>` using the
same account and global directories to recreate the launcher. Back up first
and follow the [manual package-manager procedure](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun).

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

Registry package updates inspect the exact target's Node requirement before
staging or running package lifecycle scripts. An incompatible Gateway runtime
produces `preflight-node-runtime-incompatible`, with the target version, required
engine range, selected Node version, and an upgrade command. If the Gateway
service pins a Node executable, update that service definition too; changing
the shell's Node alone does not change the service. The updater keeps the
requested OpenClaw target and does not select another release automatically.
Later runtime capability checks can still produce `node-runtime-preflight`.
If the managed helper exits before acknowledging startup, the update report includes
a bounded, redacted tail of its startup errors. The Gateway keeps serving. This
diagnostic capture must be present in the installed updater; a newer candidate
cannot repair an older updater's missing startup diagnostics.
npm directory permission failures produce `global-install-permission-denied`,
naming the directory, its owner when available, and the next action. Dry-run JSON
includes these outcomes in `failures`; the update report and Doctor's update
history retain recorded failures. The serving Gateway stays in place during
these preflight checks.

After an external reinstall changes the OpenClaw installation root, such as
installing a newer Node version with nvm, mise, or Homebrew and reinstalling
OpenClaw, Gateway startup repairs managed plugin host links before checking
plugin availability. Stale or dangling links are rebound to the current
installation, with a warning showing the old and new targets. Developer-owned
path installs and links outside the plugin system's owned locations are left
unchanged. If filesystem permissions prevent repair, startup reports the
affected plugin and keeps it unavailable until the links can be repaired with
`openclaw doctor --fix`.

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
Gateway. Changed plugins, pending plugin migrations, or deferred model retirement
run fresh Doctor repairs before restart; required repair failures still block startup.
After the candidate takes ownership of finalization, optional diagnostics with
complete lint coverage can run after verified readiness. Their warnings and retry
commands remain in the update report while the Gateway serves. Missing diagnostic
selectors cause the checks to run before startup instead.
If post-plugin lint execution cannot finish because of lock contention, a timeout,
or an inspection failure, the verified core update continues with a recorded warning
and the original lint diagnostics. Run `openclaw update repair` to retry those
checks, stopping the Gateway first when the repair asks for exclusive state
access. Concrete readiness findings and unverified process cleanup still block
completion.
The final report records downtime through convergence and final verification,
plus verification results. See
[Validation and activation](/cli/update#validation-and-activation) for the checks.

Post-update configuration and settlement reads wait for temporary SQLite
maintenance custody within the existing update allowance. If that wait expires,
contention alone preserves automatic Gateway recovery; an actual data-at-risk
refusal still blocks recovery. Doctor publishes its completion result only after
its maintenance resources have been released.

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
Doctor and policy checks use the copied deployment settings, so an accepted
policy attestation remains valid for an unchanged deployment. Only after these
checks finish does the canary apply its temporary token, disable Tailscale and
Control UI, and suppress background services for Gateway startup. Genuine policy
drift still fails validation; no attestation pin is changed or skipped. The updater
running the rehearsal must contain this fix; a newer candidate cannot undo
configuration overrides already applied by an older updater.
Doctor omits the onboarding URL warning derived from that temporary loopback
binding during rehearsal; other findings remain visible.
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
Failures to remove private candidate copies or Git inspection worktrees are
warnings that identify the cleanup path and error class. They preserve the
original candidate result and the installed runtime's recovery verdict.
Unverified process cleanup still requires its recovery owner.
If a copy fails, active copies finish before cleanup; link publication and
verification run only after all file copies succeed. Each private copy or inspection
uses one generous absolute allowance derived from its inventoried size, with the
caller's larger allowance preserved. Progress remains diagnostic and does not renew
the allowance. Exceptionally slow storage may require another update attempt after
a visible timeout. Stored state and recovery backups retain their existing
durability guarantees. An older installed updater keeps
its initial snapshot behavior until you launch an update from the newer version.

The complete validating phase, including snapshot progress recording, has a
30-minute default deadline even when `--timeout` is omitted. This uses the normal
update-step allowance so slow storage has time to finish; an explicit `--timeout`
sets the phase's allowance instead. Progress does not extend that deadline.
Cancellation may use up to the same allowance to settle accepted work before
releasing its ownership.
Update-history writes retry a timed-out commit admission at most three times,
releasing the SQLite writer between attempts. Ordinary progress that still cannot
be recorded, including a worker queue-capacity refusal before dispatch, produces
a warning and validation continues. Snapshot progress keeps one write in flight
and coalesces pending observations to the latest progress. Required recovery and
terminal records report a failure instead of retrying forever. These limits apply
when the newer installed updater runs; staging it cannot change an older driver's
already-running progress writer.

If the `2026.10.4` updater stops with `candidate-snapshot-failed` and
`SQLite worker queue capacity reached`, staging a newer candidate does not replace
that progress writer. Preserve a verified state backup and follow the
[manual package-manager procedure](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun)
to install a release containing the fix, stopping and starting the Gateway through
its actual service owner. Keep the same account, installation prefix, profile,
and state paths; do not delete databases or disable consistency checks.

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

Shell completion-cache refresh is best effort. If it times out and its process
cleanup is verified, finalization records the failed cache phase and deadline
warning while allowing the update to finish. Run `openclaw completion --write-state`
to refresh it manually. Unverified process cleanup still blocks finalization;
the updater does not report success while owned work may remain active.

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

If an updater-owned recovery directory, helper, or journal gains group or other
permissions, the updater restores owner-only access and warns with the path,
observed mode, and link count. On Linux, this also clears the effective POSIX ACL
mask; named ACL entries can remain but no longer grant access. When `getfacl` is
available, the warning identifies detected ACL entries. Foreign ownership,
symlinks, unexpected object types, multiply linked files, and permissions that
cannot be repaired still require intervention. Repairing these private objects
does not change package-content fingerprints or authorize recovery of modified
package files.
If recovery still refuses, automatic update and managed-service handoff reports
retain its reason code and diagnostic message in the failed phase.

On FreeBSD, `repair` and `retire` read process identity through the recorded
installation's own `@openclaw/proc-safe` dependency and its FreeBSD platform
addon: the live package, or the copy the operation retains beside it during
publication. Helpers written by older
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

### Recover an unfinished publication after a remount

An older updater can reject an unfinished journal before downloading a fix when
filesystem device numbers change after a reboot or remount. With a version containing
this fix installed, run `openclaw update repair` from an independent terminal. Repair
can settle `prepared`, `publishing`, `publication-complete`, and superseded operations
when the journal's inodes still match under a consistent device-number mapping.
Ordinary update admission stays strict.

This settlement first shipped in 2026.10.5. Earlier releases, including the
2026.9 extended-stable line, refuse with `Package publication journal does not
match its installation` and cannot settle the change themselves; starting with
2026.10.7, the message also names the changed bindings. From an earlier
release, install 2026.10.5 or newer with the
[manual npm procedure](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun),
then run `openclaw update repair --yes` from the new installation. See
[#170031](https://github.com/openclaw/openclaw/issues/170031).

If the installed updater cannot read the journal, a separately installed OpenClaw
version containing this fix provides the same settlement-only path:

```bash
node /path/to/recovery-openclaw/dist/package-update-activation-recovery.mjs \
  --anchor '/absolute/path/to/.openclaw.package-activation-<key>' \
  --operation '<recorded-operation-id>' repair
```

Use the original anchor and operation ID with a supported external Node or Bun
runtime. Keep other updaters and package managers stopped. Ordinary `status` and
update admission remain strict for unfinished identity-mismatched journals.

The helper can refuse when retained launcher evidence is missing. In one
report, the 2026.10.5 helper refused a 2026.9.33 `publication-complete` journal
whose anchor held only `previous`, with `ENOENT` on
`<anchor>/launchers`. No supported procedure covers that layout yet. Preserve
the journal, anchor, and retained generation, and report the exact output.

If publication never started and the previous package is still installed, repair
verifies its full tree fingerprint and unchanged launchers under the same device
mapping, then settles the operation as `publication-not-started`. The candidate
is retained as evidence; the installed package is unchanged. A previous package
with unfinished publication intent or launcher receipts still requires its
original recovery owner and is not silently archived.

For an already installed candidate, repair requires the staging path to be absent,
consistent device-number changes with matching object inodes,
the original intact helper and retained previous generation, a matching full
candidate-tree fingerprint, valid package inventories and manifest, and unchanged
launchers. Device projection applies only to digest verification: historical
identities in the journal are not rewritten. Version or inode matches alone do
not qualify; changed content, unsafe journal permissions or links, active update
ownership, and unfinished rollback remain refusals.

Symlink launchers may have different recorded permission modes (for example,
`0755` and `0700`) if their targets and required identities still match. Regular-file
launcher modes and package-tree integrity checks remain enforced.

If a manual installation has replaced the candidate with a newer version, repair
verifies that installation's manifest, dist inventories, entry targets, and launchers
before archiving the old operation as `superseded-by-manual-install`. Old package
trees and helpers remain preserved as evidence; they do not have to pass the old
candidate's fingerprint checks.

For the recorded candidate, under fresh executor ownership, repair records
`publication-settled-external-change` and preserves the entire journal and recovery
evidence in the reported archive. Removing that closed receipt from the active
admission path lets the older updater continue without interpreting a new receipt
kind. If archival fails while the active receipt remains, resolve the reported
error and rerun the same command. If the helper reports an unconfirmed archive
after moving the control directory, preserve and inspect the reported archive;
the original command no longer has an active journal to reopen. The helper does
not republish or roll back a package, delete retained generations, or restart or
verify the Gateway. It does not execute the original helper. Other unfinished
layouts still require their original recovery owner.

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

`openclaw update` automatically settles a `prepared`, `publishing`, or
`publication-complete` operation when the live candidate passes the same
verification as repair, even when the update lease is unchanged. It also retires
an untouched preparation after verifying the original package and launchers.
This does not republish files beneath a running Gateway. A dry run previews
settlement without changing recovery artifacts. Unfinished publication that
still needs file changes, pending rollback, and failed verification retain their
recovery artifacts and report the repair command.

After a managed-service update fails before stopping the original Gateway,
the handoff checks whether that original version is still serving and records
the outcome. A stopped Gateway or unavailable health check is reported with
its reason. This observation does not restart the service or mark the attempted
update successful.

To explicitly settle an external-helper operation stuck at `prepared`, `publishing`, or
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

After migration, recovery checks the installed candidate's schemas before
restarting a Gateway stopped by the update, even when normal Doctor completion
did not need a process-settlement receipt. A later verification error does not
make the previous package compatible with migrated state. Obsolete package
backup cleanup is best effort: locked files or denied renames produce warnings
with the retained path and filesystem cause, without failing verified activation.

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
or inconsistent registry data stops the update; it never falls back to `latest`.
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
keep their package-manager behavior. Dev target inspection fetches only the selected
upstream source, respecting the repository's ref mappings and exclusions. It does
not download unrelated branches or change the repository's shallow boundary.
Stable and beta target inspection fetches release tags only, without refreshing
remote branches.

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
If npm postinstall emits this typed refusal, the updater reports it without
retrying the install with optional dependencies omitted. Other install failures
retain their existing retry behavior.
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

In the Control UI, expand **Update available** in the Inbox to check the latest
Dev Git target. The card checks again before opening update confirmation. While
checking, it hides the previous SHA and disables the update action. A failed
check shows an error; retry the action to check again. Opening the card does not
start an update.

Update confirmation belongs to the Gateway and profile that opened it. Switching
Gateways or profiles retires the pending confirmation; open it again on the
intended Gateway. Native updates also check current administrator access when you
confirm and show an access error if it was revoked. Once an update starts, its
progress report remains available through that Gateway's restart.

Ask the agent to update OpenClaw, or send `/update` from Discord or another
connected chat. Natural-language requests use the existing `gateway` tool's
`update.run` action. The same tool exposes `restart` for a runtime-coordinated safe
restart and `update.cleanup` for explicit recovery cleanup without stopping the
Gateway. The minimal, coding, and messaging profiles expose these maintenance
actions without granting configuration reads. Explicit tool restrictions still apply.

On an explicit owner request, the agent performs the supported action itself; it
does not send the owner to a slash command or terminal. Restart requests can be
deferred until active work settles; an accepted schedule is not a completed restart.
Cleanup uses the serving Gateway's owner-bound worker and the existing manual
verification, eligibility, and dependency checks. It permanently removes eligible
rollback copies, so it requires a cleanup request. Set `dryRun: true` to preview.
It does not select unmanifested paths or stop/restart the Gateway.

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
an update that stops before restart sends only the notices for phases it reached.
Restart recovery reuses an already-recorded completion notice even if later
verification changes the outcome. The run report remains the current source for
that outcome. A milestone with no eligible delivery target is recorded as skipped
instead of retried on every recovery check.

If the update cannot start, the bot records and explains why and provides the manual command when available.
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
Agents use runtime-supervised maintenance rather than an unsupervised shell
stop/update/start sequence or package swap. The runtime retains restart ownership
before stopping the Gateway. Non-owner requests remain refused, and chat restarts
honor `commands.restart` just like chat updates. Cleanup does not depend on that
flag because it does not restart the Gateway.

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

Standalone repair reports the `repairing` phase while Doctor and plugin maintenance
run. Its `finalize:*` history steps identify the current operation.
Before maintenance, repair marks confirmed dead drivers as abandoned while
preserving their history. Completing maintenance is acknowledged separately, so a
later repair failure does not leave those exited drivers recorded as running.
Runs with retained recovery custody stay with their recovery owner.

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

An empty update history does not mean the installation is free. If
`openclaw update` reports that another update executor owns the installation and
names cancelled update custody, an earlier cancelled updater exited without
releasing it. Run `openclaw update repair`; it settles that custody once the
updater and its descendants are proven gone, and otherwise reports the blocker,
exits with code 2, and leaves the next update blocked. See
[Update repair](/cli/update/repair-and-recovery#update-repair).

OpenClaw 2026.9.2 does not reject a new CLI update because an older running row
exists: its [admission path](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/cli/update-cli/update-command-run.ts#L77)
creates a new run, and its [ledger](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/infra/update-run-ledger.ts#L250)
checks only for a duplicate run ID. Upgrade normally, then use the updated
`openclaw update repair` if the old history remains. A package-manager escape
is not required for this ledger defect. See [Update run history](/cli/update#run-history-and-reports).

## Retire update recovery data

Once you have verified the update and your conversations, ask the agent to clean
up update recovery copies. The `gateway` tool's `update.cleanup` action runs under
the serving Gateway's ownership; no stop is needed. It also accepts `dryRun: true`
for a preview. The standalone CLI keeps its offline apply requirement below.

To preview retained migration originals from a terminal:

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

Standalone repair cancels its pre-repair original-state capture after ten minutes.
If that capture times out, Doctor waits for its workers to settle and reports a
warning with backup and retry instructions; repair-specific migration backups still apply.
Doctor restores a managed Gateway it stopped, including after SIGINT, SIGTERM,
or SIGHUP interrupts repair. If restoration fails, it prints the failure and the
command to start the Gateway after resolving it.

On Linux, `openclaw doctor --fix` can reclaim abandoned updater runtimes even
after a systemd user-manager re-exec. The manager's `--deserialize` argument and
its protected `(sd-pam)` child do not count as runtime holders. Actual runtime
references and unverified processes still preserve the affected artifacts.

On Windows, `openclaw doctor --fix` can also retry abandoned backup scratch
cleanup after an older release reported `EPERM` while renaming to an
`openclaw-backup-retired-*` directory. Active backup scratch and published
archives remain protected. See [Backup scratch cleanup](/cli/backup).

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

Background-command completions can trigger follow-up turns in their originating
session even when recurring automations are disabled. To keep background exec
without these extra model calls, set `tools.exec.notifyOnExit: false` and check per-agent
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
