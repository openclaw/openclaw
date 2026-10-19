# Interim deployment controller

This is the deployment controller bundled with the repository's
[update-team-server skill](../SKILL.md). It preserves the existing managed-release
owner while native `openclaw update` gains and proves the remaining migration,
recovery, acceptance, and adoption contracts. It is not another scheduler or an
alternative public update CLI. Do not add it to runtime packages or default
Vitest projects.

The controller originated in Manager commit
`d02035d40a9a2a9d73afee700aec26a10d1c66a9`, directory
`ops/openclaw/team-hourly-update/`. Schema migrations now belong to the candidate
release's native update/Doctor path. The controller does not enumerate supported
schema edges or rehearse migrations on copied databases. See the
[immutable update design](https://docs.openclaw.ai/reference/team-immutable-update-design).

## Schema updates and recovery

Ordinary deployments wait up to 180 seconds when the canonical deployment lock
is busy, allowing routine health checks and disk maintenance to finish without
discarding the update request. The controller retains the same exclusive lock
and post-lock maintenance-idle admission. A wait timeout exits `75` (deferred),
not a successful `SKIP`; other lock errors retain their failure status. Bound
maintenance and recovery actions retain their immediate contention refusal.
This change requires complete-pair adoption; landing it does not deploy it.

The incumbent keeps serving while the controller builds and seals the candidate.
For a schema crossing, the controller takes its ordinary maintenance suspension,
drains and stops the Gateway, then invokes the candidate:

```sh
node <candidate>/dist/index.js update migrate --backup-root <transaction>/native
```

This internal supervisor command uses the same native database backup and Doctor
owners as `openclaw update`. It rejects databases newer than the candidate,
captures WAL-safe backups and authored configuration before repair, and writes a
durable receipt before Doctor can migrate. Forward migrations are selected by
OpenClaw, including crossings that the controller has never seen.

After migration, the controller selects the candidate, starts it, and verifies
readiness and real session continuity through the existing acceptance path.
When activation fails, it stops the owned candidate, invokes its `update restore`
command with the same backup root, restores the old release pointers, and
verifies the predecessor. Native restore retains the displaced candidate
databases for diagnosis. If restoration cannot complete, the Gateway stays
stopped with the journal and backup intact; it never starts an old reader on
newer state. A retained transaction resumes through `--recover`.

For a retained native-update transaction, `--recover` first checks whether the
selected candidate is already the running system Gateway. It binds that
candidate's process generation and runs full deployment acceptance, including
identity, RPC, health/startup/readiness, configured channels, and session
continuity. Successful forward recovery records the verified candidate and
retires the exact journal without draining, stopping, restarting, or restoring
the Gateway. The native backup remains on disk. This also applies to
`ROLLBACK_FAILED` with the candidate still selected. An absent or unverifiable
candidate follows the existing compatibility-checked rollback path.

An interruption while the native owner publishes restored database files can
require explicit recovery of the retained backup and displaced files. Database
publication is not resumable per file; recovery fails closed instead of starting
the predecessor on a mixture of database generations.

These commands are lifecycle-owner interfaces, not a second public updater.
They require stopped writers. Build, drain, migration, and readiness have their
own existing budgets. A migration can still take substantial downtime: the
controller removes deployment-specific admission machinery, not the work
performed by the database migration itself.

Candidate acceptance and predecessor rollback use the same verification owner.
`OPENCLAW_TEAM_VERIFICATION_BUDGET` defaults to 600 seconds and bounds each
started process's convergence, marker admission, dispatch reconciliation, and
terminal observation together. An empty loopback listener snapshot waits within
that deadline and emits one `VERIFICATION_WAITING` diagnostic per acceptance
attempt; an invalid or foreign listener still fails verification. Deadline expiry
still emits `VERIFICATION_FAILED`. Readiness waits and RPC retries never renew that
deadline. The 60-second marker RPC timeout bounds a transport exchange; it is
not the whole startup acceptance window.

Before the marker, the owner waits for native `/startupz` to report that critical
initial startup has settled, `/readyz` to report readiness without a refusal for
the configured `modelAgent`, and a sampled main-thread delay below one second.
A `system.info` response within ten seconds must identify the same process and
instance. CPU/utilization warnings with bounded loop delay permit default
acceptance; native degradation remains reported and steady profiling remains
ineligible under load. The existing `--allow-cpu-degraded` argument remains
accepted for installed service invocations. Native background recovery,
transcript maintenance, and prewarming
can continue after initial startup readiness; their completion is not another
acceptance gate. A native `agent-database-inspection` startup reason for other
agents does not delay an admitted model agent when `/readyz` is healthy; critical
sidecar startup and the model agent's own pending admission still wait. Missing
transport responses and pending startup/admission
facts wait inside the original budget. Malformed evidence, corruption, changed
identity, protocol failures, and authentication failures remain failures.
If native readiness becomes unavailable again after convergence, a well-formed
HTTP 503 readiness snapshot waits within that same deadline. It never authorizes
marker dispatch. `elapsed_seconds` in `VERIFICATION_FAILED` measures the named
step, not the elapsed startup or marker budget.

If marker dispatch has a typed transport timeout, the owner checks readiness
again and replays the byte-identical request with its original idempotency key.
The Gateway owns reservation and replay; a minimal `in_flight` acknowledgement
still names that same run. Acceptance requires the subsequent `agent.wait`
terminal receipt to bind the exact session, visible marker, and configured
requested provider/model. The effective model must be that primary or one of its
configured fallbacks captured with the protected policy; fallback changes are
policy changes. The release's native model-reference parser separates auth-profile
suffixes for receipt comparisons; the full configured references remain protected.
A successful configured fallback remains valid when the primary
is rate-limited. Neither a healthy probe nor a timeout becomes successful
acceptance. A deadline expiry retains recovery evidence.

Suspension drain defaults to 30 seconds even when the controller is invoked
outside its systemd unit. Larger `OPENCLAW_TEAM_DRAIN_BUDGET` values are capped
at 30 with a diagnostic. The controller acquires one drain lease and never
renews it; the Gateway owns its absolute 45-second cutoff. After the drain
budget, transient write custody receives at most five more seconds before the
controller defers and resumes its exact lease. Final custody reads retain the
five-second RPC bound. The remaining grace permits handoff or cleanup; pending
writes never become permission to stop. Adopt this controller closure alongside
the Gateway's bounded-drain change; landing either does not deploy it.

Activation audits the current and previous sealed release trees before closing
Gateway admission. The deployment lock excludes other pointer writers; a direct
current-target comparison still precedes journal publication. Fresh suspension,
process-generation, protected-identity, and policy checks remain at the stop
boundary, including after handoff arming. Adopt the reviewed controller closure
to move these audits out of the client-visible offline window.

During graceful suspension drain, status reads use a five-second transport and
subprocess bound (shortened by the original drain deadline). A typed timeout,
connection loss, or service-restart close retries after one, two, then at most
four seconds, with each wait capped by the remaining drain budget. These reads
do not renew the deadline or the suspension lease. If request preparation consumes
the remaining budget before CLI dispatch, the same deadline policy applies; no
RPC is started. Missing or malformed failure
evidence, authentication or protocol failures, and definitive Gateway refusals
remain fatal. Deadline expiry still requires the existing fresh lease,
process-generation, and write-custody proof before authorized interruption;
failed observations never authorize stopping the Gateway. Adopt the changed
script and library together through the complete-pair procedure below.

Migration and restoration receive at least two hours, or the existing build
budget when larger. A measured synthetic 25 → 26 crossing took 4m04s for
3.865 GiB, roughly 39 minutes at 37 GiB by linear extrapolation before backup;
this estimate does not predict production downtime.

Complete any transaction created by the former controller using its original
installed closure before adopting this version. Its edge-specific journals and
rehearsal artifacts are not inputs to the generic update path.

## Installed closure

Install from one reviewed, merged OpenClaw commit. These four files are one
versioned closure; a new deploy script with an old library is not supported.
All installed files and their parent directories are owned by `root:root`, with
no group or other write access. Libraries use mode `0644`; the executable uses
`0755`; parent directories use `0755`.

| File                              | Installed path                                                 | Responsibility                                                              |
| --------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `openclaw-release-deploy`         | `/usr/local/sbin/openclaw-release-deploy`                      | Deployment, recovery, and maintenance orchestration under the existing lock |
| `release-lib.mjs`                 | `/usr/local/lib/openclaw-team/release-lib.mjs`                 | Release admission, journal, native-update handoff, and acceptance           |
| `gateway-suspension-contract.mjs` | `/usr/local/lib/openclaw-team/gateway-suspension-contract.mjs` | Self-contained pinned suspension protocol validator                         |
| `startup-profile.mjs`             | `/usr/local/lib/openclaw-team/startup-profile.mjs`             | Controller-owned startup capture lifecycle                                  |

The suspension bundle is unchanged and its SHA-256 is pinned by the library.
The library imports the startup profiler beside itself. Candidate config repair
modules and SQLite extensions come from the sealed candidate release, not this
directory. Existing host maintenance commands remain separate owners.

Install [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) alongside the libraries
as `root:root`, mode `0644`: the unchanged suspension bundle includes TypeBox
1.3.34 under its MIT license. The notice is distribution metadata, not another
runtime module.

The effective existing updater service must execute
`/usr/local/sbin/openclaw-release-deploy` as root. The historical
`openclaw-hourly-update.release.conf` clears `ExecStart` and selects this command;
it is an existing operator-owned service input, not a new installer. Preserve
all current service limits, environment, locks, and drop-ins. Do not install the
old mutable wrapper, enable the historical timer, or invent a second cadence.

## Private operator configuration

Supply `OPENCLAW_TEAM_OPERATOR_PROFILE` as JSON in the updater's private,
root-controlled environment. Keep its source file `root:root`, mode `0600`,
outside the source checkout. Reuse the same value for every controller and
library invocation, including recovery and manual read-only diagnostics.
Do not derive expected values from the candidate: they express the operator's
previously approved acceptance policy. Missing or malformed required values
fail verification.

The object has these fields:

- `channels`: a nonempty array of distinct `[pluginId, accountId]` pairs that
  must each be exactly ready.
- `modelAgent`: the configured agent whose model is checked and whose isolated,
  non-delivering acceptance marker runs. The existing default-model fallback
  remains unchanged.
- `policy`: expected `mode`, `workspaceOnly`, `updateAuto`,
  `clickclackCommandMenu`, and `appServer`. The latter contains `mode`,
  `approvalPolicy`, `approvalsReviewer`, `sandbox`, and `defaultWorkspaceDir`.
  Other actual app-server fields remain in the captured policy, preserving
  subsequent drift detection. `updateAuto` must remain `false`. The complete
  profile is checked during the pre-cutover policy check, including channels.
- `handoff`: only required for the existing host-handoff config verification;
  contains `provider`, `sourceBaseUrl`, and `targetBaseUrl`. Verification still
  allows only the approved endpoint change, worktree-root relocation, and
  native metadata normalization.

`test-environment.mjs` is a synthetic test profile, **not a deployment default**.
Night Watch must transcribe the incumbent's approved private values and compare
its policy/channel/handoff results before adopting this closure. Protect and
bind the profile together with the code; changing it changes acceptance policy
and requires its own operator authorization.

Privacy changes are limited to replacing hard-coded deployment expectations
with this profile, generic error wording, removal of private campaign labels,
and synthetic test identities/endpoints/models. The deploy script's marker
uses `modelAgent` for both dispatch and acknowledgement checks. With the
incumbent values configured, these comparisons and marker addressing are the
same as the source. No private endpoint, coordinator session ID, credentials,
operator notes, or host inventory belongs in this public directory.

Independent import review also identified existing runtime defects repaired
here: stopped-owner checks now reuse the native stopped-manager proof when the
retired user bus is absent; source export distinguishes PID reuse from the
original Gateway generation while still checking database writers; and optional
profile closure compares activation hashes from the same phase. Pointer
publication propagates failures before another lifecycle step; history
verification checks captured transcript generations even when a logical session
key survives. Rollback arms the native handoff before stopping a
draining successor, and recovery verifies the restored predecessor
before retiring its journal. Stopped-current recovery waits for a restored
persistent timer's catch-up invocation before applying its final snapshot checks.
The profile inspection change is transient; persisted arm records keep their existing shape.
Tests cover these repairs and use one prepared lease expiry in custody fixtures.

The controller delegates retired Workshop proposal preservation to native Doctor.
Doctor owns draft export and recovery warnings before dropping the retired tables;
the controller must not require those rows to remain in SQLite. Its original
lossless backups, physical database ownership checks, and session witnesses still
apply. See the [state schema history](../../../../docs/reference/database-schemas/state-schema-history.md#skill-workshop-proposal-retirement-state-schema-20-same-version)
for the retirement contract.

## Complete-pair adoption

Release preparation fetches only the frozen commit from the already verified
official mirror. Each candidate keeps its own shallow Git object database, with
no alternates or dependency on the mirror after publication. Ancestry checks
continue to use the full mirror before preparation.

Capacity admission measures each release tree in one Python subprocess, keeping
large metadata walks outside V8 after an optimized `lstatSync` loop crashed.
It still budgets each entry's larger logical/allocated size, counts hardlinks
separately for independent copies, does not follow symlinks, and rejects special
files or filesystem crossings. Byte/inode reserves and shared-filesystem demand
aggregation remain unchanged. Python 3 must be available to the controller;
failed inventories refuse admission. This change requires ordinary complete-pair
adoption and does not change the selected controller or Gateway runtime.

The build account retains pnpm's content-addressed store under
`OPENCLAW_TEAM_BUILD_HOME/cache/store` across candidates. The frozen lockfile and
pnpm's integrity checks select package contents; `clone-or-copy` imports keep
candidate files independent of writable store inodes. pnpm owns store format,
invalidation, and pruning. Operators can reclaim unused packages with
`pnpm store prune --store-dir <build-home>/cache/store` as the build account when
the deployment owner is idle. Candidate cleanup removes only the work and
staging trees. Staging uses reflinks where supported and ordinary copies
otherwise; sealing, filesystem ownership, manifest validation, and directory
publication remain unchanged. The build account also retains the build owner's
artifact cache at `cache/build-artifacts`. Input content hashes select reusable
package, plugin, and Control UI outputs; copies use independent inodes and reflinks
where available. A missing, changed, or incomplete cache entry rebuilds normally.
This cache is disposable while the deployment owner is idle.

The fresh build overlaps the Control UI's staged build and precompression with
runtime finalization after the compiler and plugin builders finish. Both
writers finish before final build metadata is emitted, including when either
fails. Runtime compiler configs overlap in pairs only with the build owner's
full 12 GiB heap budget; smaller budgets retain serial native allocations.
All build checks still run; cached compiler output never substitutes for a
validation result. The Control UI refreshes release identity and its offline
shell even when its bundles and precompressed assets are reused.

Sealing makes every regular file read-only (preserving executable bits as `0555`),
every directory `0555`, and leaves relative in-tree symlinks intact. The staging
copy has independent inodes, is root-owned, and is not exposed to the runtime
user. After the permission walk, sealing fsyncs regular files followed by
directories, with at most eight open handles at once. This persists file bytes,
inode modes, symlinks, and directory entries before publication without requesting
a filesystem-wide flush of unrelated dirty data. Storage contention can still
slow those operations. The durability deadline is two minutes plus ten
milliseconds per file/directory and one second per eight MiB of file data.
A failed fsync or expired deadline aborts publication; no sync subprocess is
left behind. The rename retains its separate parent-directory fsync. Adopt the
script and library together to remove the former fixed 120-second sealing bound.

The manifest binds the exact source SHA, build ID, schema declarations, official
origin, and Control UI entrypoint SHA-256; validation also checks build stamps,
asset presence, ownership, modes, and contained symlinks across the tree. This
is a durable, owner-protected release, not a cryptographic digest of every file
or protection against subsequent root writes. New builds also record their
selected input hashes in `dist/build-cache-inputs.json` and the deployment
manifest. Admission compares these records; older sealed releases without cache
metadata remain supported. Sealing preserves the existing integrity contract.

Release publication now prewarms Node's release-scoped compile cache before
cutover, including reuse of an already published release. The bounded import
runs as `openclaw`, with the selected Gateway runtime, after publication at its
final path. It loads the Gateway graph without starting a server or reading
Gateway state; the existing cache owner chooses the build-ID namespace and
retention policy. Missing prewarm entries in older releases are skipped, and
prewarm failures warn and leave ordinary cold startup available. Bun does not
use Node's compile cache. Night Watch must adopt this reviewed controller
change through the complete-pair procedure below; landing it does not change
the installed controller or authorize a Team deployment.

Only the designated Night Watch executor performs these steps. Resolve its
exact host and coordinator session from the private operator record, preserve
per-deployment approval, and coordinate any intentional restart there. A code
publication is not a deployment or a request to restart the Gateway.

1. Stage the four files from one merged OpenClaw commit, verify their reviewed
   hashes, and run `bash -n` on the executable and `node --check` on the modules.
   Prepare the private profile from incumbent expectations. Never stage Manager
   source, notes, or an operations repository on the deployment host.
2. Through the current owner, settle all old controller readers, including
   manual and pre-lock invocations. Require the updater service's `MainPID` and
   `ControlPID` to be zero, no queued job, and no unresolved activation journal.
   Bind the installed closure/profile identities and hashes, Gateway
   PID/start/invocation, release pointers, config/database identities, loaded
   startup guard/permit, and disabled deployment schedule.
3. Acquire the existing deployment lock on file descriptor 9 without replacing
   its inode. Recheck the bound facts under that lock. An unresolved transaction
   needs its existing recovery closure and a separately reviewed exact-phase
   procedure; never clear its journal to make installation possible.
4. Preserve exact predecessor bytes, ownership, modes, and profile in a private
   recovery directory and fsync it. Stage replacement files alongside their
   destinations with the modes above; fsync files and parent directories.
   Recheck admission, then rename the complete pair and matching changed helpers
   while all readers remain excluded. Multiple renames are not an atomic pair:
   on interruption, keep exclusion and reconcile every file before allowing
   any reader. Restore only through that same bound recovery procedure.
5. Verify all four installed hashes, ownership/modes, profile, syntax, and the
   unchanged runtime bindings before unlocking. Retain predecessor recovery
   artifacts while referenced. Report publication to Night Watch's coordinator;
   actual deployment and native acceptance remain a separate approved action.

## Standalone tests

Use disposable Linux with Node 24.16+ or 26.1+, Bun 1.4.3+, Bash, Python 3, GNU
coreutils, `flock`, and `/usr/bin/bwrap`. Full coverage requires root and working user/mount
namespaces. Tests use synthetic temporary state, services, processes, and
Gateways; they do not contact Team. Some boundary tests extract Bash functions;
owner-flow tests execute the real deploy entrypoint with external service stubs.
This suite does not prove a live systemd cutover or production acceptance.

The runtime deliberately pins the suspension bundle's installed path. Runtime
tests require actual root-owned Node and Bun binaries under root-owned,
non-writable ancestors; symlinks into a user's toolcache do not qualify. Provide
them at `/usr/bin/node` and `/usr/local/bin/bun` on the disposable host. Copy the
test closure with matching ownership. Run the suite as root for its explicitly privileged cases:

```sh
controller=.agents/skills/update-team-server/controller
sudo install -d -o root -g root -m 0755 /usr/local/lib/openclaw-team /opt/openclaw-controller-test
sudo cp -R "$controller/." /opt/openclaw-controller-test/
sudo chown -R root:root /opt/openclaw-controller-test
sudo chmod -R a+rX /opt/openclaw-controller-test
sudo install -o root -g root -m 0644 "$controller/gateway-suspension-contract.mjs" \
  /usr/local/lib/openclaw-team/gateway-suspension-contract.mjs
sudo install -d -o root -g root -m 0755 /var/tmp/openclaw-controller-root
cd /opt/openclaw-controller-test
sudo env TMPDIR=/var/tmp/openclaw-controller-root /usr/bin/node \
  --import ./test-environment.mjs --test ./*.test.mjs
```

Use disk-backed temporary storage with at least 18 GiB free. A smaller `/tmp`
tmpfs correctly fails the controller's production headroom checks before these
fixtures reach their intended boundaries.

Inspect failed **and skipped** counts. Non-root or unavailable bubblewrap skips
are coverage gaps, not full success. Run the repository changed-file gate and
closure guards on the same candidate as well. The Node suite stays opt-in;
there is no new default CI/Vitest workload.

## Deliberately omitted

The mutable `openclaw-hourly-update`, `openclaw-release-cutover`, old service and
timer templates, and Manager installer/inventory/runbook test are not loaded by
this closure. Existing host service configuration stays with the operator.
The two `team-metal-*.py` tools are one-off transaction glue. The historical
`suspension-contract-provenance/` toolchain, manifests, and legacy pair are not
runtime inputs; the validated generated bundle is retained byte-for-byte.

`update.test.mjs` becomes `release.test.mjs` after removing only its retired
mutable-updater fixture and cases. `suspension-custody.test.mjs` retains current
custody/tamper coverage and omits the two historical mixed-pair cases that need
the excluded legacy snapshot. Other controller tests and their support fixtures remain. New profile tests cover the publication substitutions.
The lease and handoff fixtures retain their assertions while updating their
canonical database layout, command responses, and independent capacity inputs.

## Source integrity

Hash all four files from the exact reviewed, merged tree before adoption. Retain
those hashes with the operator's installation receipt and predecessor closure.
A historical import hash is provenance, not approval to install modified bytes.
