---
doc-schema-version: 1
title: "Team immutable update design"
summary: "Immutable update design: installation, preparation, native activation, and retained recovery contracts"
read_when:
  - Designing native updates for an installation with sealed release directories
  - Reviewing the Team deployment controller cutover
---

# Team immutable update design

**Implementation design; preparation and explicitly enabled native activation are implemented. No deployment authorization.** Finish the
immutable installation adapter in `openclaw update`. Keep update orchestration,
activation recovery, Doctor migrations, and service lifecycle with their existing
owners. Do not port the private deployment controller into core.

The original inventory used main at
`e4dc2512b87419b12f1d9cfbbe5f2860fd9b869e` on October 2, 2026. The owner inventory
below now includes native immutable preparation, activation, recovery, and status
projection. The incident timings and controller inventory
are supplied campaign evidence, not measurements or private-controller source
verification performed in this lane. Production was not accessed. Everything
under “Proposed contract” describes the complete design; the implemented subset is identified below.

## Implementation status

The first review slice (#163799) implemented **Detect and
adopt an immutable installation** and **Prepare everything possible while the
previous Gateway serves**. The maintainer accepted the durable descriptor
extension, retention of current plus previous and journal-referenced generations,
and an explicit adoption subcommand under `openclaw update`.

Slice 1 records adoption and prepared generations, packages the stable launcher,
and reports immutable installations through status and dry run. It does not
publish `current`, change a service definition, restart a Gateway, migrate live
state, collect generations, import private controller history, or retire that
controller.

Slice 2 adds a versioned, explicitly enabled adoption record and a native
activation/recovery owner. It reuses the suspension drain, native systemd
lifecycle, restart health, and config audit owners. Activation journals pointer
intent before publication, verifies the selected physical generation and stable
service definition, and accepts only candidate-authored additive config writes
with matching audit evidence and unchanged policy. Startup inspection remains a
bounded pending outcome. Successful verification retires the record; safe
rollback preserves it. `openclaw update recover --root <installation-root>`
reconciles uncertain effects and verifies an already healthy candidate or
predecessor without restarting it.

The startup-only canary runs before drain and again on a fresh private state
copy after live readiness, while the selected Gateway serves. Accepted startup
config migration protection is persisted before that second canary. A final
check must observe the same live PID and boot before the owner retires the
operation. These receipts prove the existing canary contract, not a native model
marker turn. Ordinary `update.status` requests refresh verified immutable
installation facts through the existing refresh owner and bypass private
manager status, keeping the activation record authoritative.

Before drain, the independent activation owner prepares and seals a full copy of
the invoking runtime under its installation-sibling control directory as
`recovery-<sha>`, reusing a verified copy for the same source SHA. The recorded
external Node runs `.control/recovery.mjs`, which dispatches to that retained
product owner without borrowing the candidate or a Manager checkout. No runtime
copy, dependency install, or build occurs during cutover. Pending and rollback
outcomes print the exact independent recovery command. Fresh `openclaw update
status` observers also expose that command and safe pending failure codes, plus
historical verified SHA, timestamp, version, build, PID, and boot identity when
recorded. Prepared candidates and pending recovery stay separate from accepted
or restored history; older receipts may lack Gateway verification details.

Activation remains disabled for slice-1 adoptions until the operator repeats
adoption with `--enable-activation`. Gateway `update.run` still directs operators
to the root CLI outside the Gateway service cgroup. The serving Gateway must
support committed suspension handoff: the existing deployment owner must first
activate one bridge release containing this capability. A candidate-side CLI
cannot retrofit it into an older running Gateway. After that bridge is healthy,
enable adoption and prove a native cutover to a different reviewed generation
before retiring the old controller. The immutable
`--drain-timeout` flag independently selects the drain budget, such as 30 seconds,
while `--timeout` retains canary/readiness phase budgets. Healthy recovery never
uses the drain budget. Gateway RPC privilege handoff is
not part of this slice. Activation requires cgroup v2 and matching schema
contracts; incompatible schema requirements refuse before drain. Startup-only
canary rehearsal uses private copies before cutover, without Doctor pre-repair,
so the candidate must handle its own additive startup migration. No live Doctor
or optional NOCOW rewrite runs during activation. General incompatible database migration/rewind,
generation collection, deployment adoption/proof, and private-controller
retirement remain separate work. The broader proposed contracts below describe
those remaining boundaries, not completed production deployment.

At final native stop preparation, the suspension owner validates the original
lease and all write custody, then the live host commits one-way shutdown before
acknowledging the handoff. Resume and expiry cannot reopen admission after that
transfer. The old arm-only contract remains available to existing callers, but
the immutable updater never falls back to it. An unknown reply retains recovery;
the host may already be stopping. If host shutdown wins the race with native
dispatch, only an inactive service with no pending job and an empty cgroup counts
as stopped; a replacement process is preserved for explicit recovery.
Before host commitment, the existing control record durably enters its stop
phase. The stable launcher reads that record without replaying journals and
blocks a supervisor replacement from entering Gateway code during stop or
pointer publication. Startup resumes only in an owner-authorized phase; no
temporary systemd policy override is needed.

Explicit v1-to-v2 enablement can reconcile a bridge selected by the existing
deployment owner. Adoption preserves stable root, releases, runtime, and service
bindings, verifies the sealed predecessor and serving bridge, and retains the
predecessor without inventing an activation-success receipt. It also upgrades
only the exact packaged v1 launcher, backing up its bytes before atomic
replacement. Custom launchers and external pointer drift after enablement remain
refused.

## Problem and performance boundary

The current deployment builds a pinned official-main revision off-path, publishes
a sealed release, drains the Gateway, changes a `current` symlink, and restarts a
systemd service. Its private controller also orchestrates Doctor, backups,
verification, recovery, and retention. This duplicates responsibilities that have
substantial native implementations now.

The reported incident combined a 2,400-second parent deadline with a 38-GB NOCOW
rewrite. Recovery then rejected legitimate changes in retained-file size after a
WAL checkpoint and in Doctor-owned `schema_meta` receipts. The reported result
was nine hours of downtime. The design must remove optional physical rewrites
from ordinary activation and consume Doctor's evidence instead of maintaining a
second interpretation of SQLite state.

| Quantity          | Supplied baseline                                                                                                                                                                          | Proposed change / evidence limit                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Build preparation | About 7 minutes, Gateway still serving                                                                                                                                                     | Preserve off-path preparation; no claimed build speedup.                                                                                   |
| Drain             | `update-immutable-activation.ts` uses `withGatewayMaintenanceDrain` and committed suspension handoff before native stop. The Gateway owner validates the original lease and write custody. | An older serving Gateway needs a bridge release; a candidate CLI cannot retrofit committed handoff.                                        |
| Gateway startup   | About 4.5 minutes                                                                                                                                                                          | Still a lower-bound problem for restart downtime; startup work belongs to lane 338.                                                        |
| Clean activation  | About 5 minutes from drain plus startup, excluding reconnect settling                                                                                                                      | Pointer publication removes build work from cutover but cannot by itself make startup fast. No measured after value.                       |
| Reconnect storm   | Reported, unquantified                                                                                                                                                                     | Preserve existing client recovery; lane 339 owns that improvement.                                                                         |
| NOCOW failure     | 38 GB; killed at 2,400 seconds; about 9 hours total outage                                                                                                                                 | Ordinary update defers NOCOW. Explicit maintenance gets measured work budgets and recoverable progress. No production replay in this lane. |

Measure preparation, admission closure, drain, stopped interval, migration,
pointer publication, authenticated readiness, and reconnect settling separately.
The acceptance target is **zero build/install work and zero optional NOCOW work
inside routine cutover**. A seconds-level outage target needs startup and client
measurements; this design does not claim one.

## Existing owners on main

The CLI entry is `src/cli/update-cli.ts` and `src/cli/update-cli/*`, rather than a
`src/commands/update*` implementation. The maintained user references are
[Update](/cli/update), [How updates run](/cli/update/how-updates-run),
[Status and history](/cli/update/status-and-history), and
[Update and plugin testing](/help/testing-updates-plugins). There is no matching
`docs/help/update*` family at this revision.

### Installation, preparation, and activation

| Surface                | Current behavior and source                                                                                                                                                                                                                                                                  | Immutable gap                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Install classification | `update-install-kind.ts` includes `immutable`; `update-check.ts` uses `update-immutable-install.ts` to inspect the adopted descriptor and pointer.                                                                                                                                           | Implemented. Directory shape alone is not ownership proof; unadopted layouts cannot fall through to mutable Git.                                |
| Git checkout           | `update-runner-git*.ts` own source preparation. `update-immutable-install.ts` freezes official main or validates an exact ancestor SHA, builds off-path, and seals a generation without fallback.                                                                                            | Build-account isolation and resource policy remain to be added to the immutable adapter.                                                        |
| Git publication        | Mutable Git promotion stays with `update-runner-git-runtime.ts`; immutable publication uses `package-update-activation-immutable-pointer.ts` and journaled rename/reconciliation.                                                                                                            | Immutable pointer publication is implemented for matching schema contracts; it is not full migration recovery.                                  |
| Global packages        | `update-runner-install-surface.ts`, `update-global.ts`, `update-native-package-stage.ts`, and `package-update-swap.ts` stage and verify npm/pnpm/Bun targets with manager-specific ownership and recovery. Candidate admission uses the package's `openclaw.updateAdmissionProtocol` marker. | A standalone extracted release is not a verified global package-manager root. Do not route it through npm merely because it has `package.json`. |
| Other installs         | Host-owned installs route to their owner. Unsupported/unowned install surfaces record an intentional skip and next action without stopping the Gateway. Containers remain image-owner updates.                                                                                               | Bootstrap immutable ownership explicitly; preserve other install methods and their tooling.                                                     |

### Lifecycle, migrations, recovery, and reporting

| Responsibility                 | Current implementation                                                                                                                                                                                                                                                                                                       | Remaining integration                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service identity and handoff   | `update-immutable-service.ts` binds the stable installation, exact generation, service definition, PID/start identity, and original cgroup; activation runs outside the Gateway service.                                                                                                                                     | Preserve those bindings when composing migration and host-maintenance admission.                                                                       |
| Drain                          | `update-immutable-activation.ts` uses `withGatewayMaintenanceDrain` and committed suspension handoff before native stop. The Gateway owner validates the original lease and write custody.                                                                                                                                   | An older serving Gateway needs a bridge release; a candidate CLI cannot retrofit committed handoff.                                                    |
| Suspension authority           | `src/gateway/server-methods/suspend.ts` delegates prepare/status/resume/handoff to `src/infra/gateway-suspend-coordinator.ts`; `server-active-work.ts` provides lifecycle inspections.                                                                                                                                       | Consume its blockers and custody facts, including newer kinds; do not vendor a frozen list of agent/chat/queue/root/session blockers.                  |
| systemd lifecycle              | `update-immutable-service.ts` delegates to the native system-scope lifecycle owner, preserves the sealed definition, and checks original cgroup extinction before pointer publication.                                                                                                                                       | Lifecycle is integrated; broader host-maintenance coordination remains separate.                                                                       |
| Doctor                         | `src/commands/doctor-maintenance.ts`, `doctor-maintenance-state.ts`, and `src/infra/update-doctor-result.ts` own maintenance custody, config/schema repair, typed results, config-write chains, and database generation evidence.                                                                                            | Pass the prepared migration requirements and existing authority into candidate Doctor. Controller profile strings are not a new migration API.         |
| WAL-aware backup               | `update-database-backup.ts`, `update-database-generations.ts`, and `update-database-restore.ts` capture verified SQLite snapshots and reject unsafe restoration. Snapshot-volume admission reserves `2 × total family bytes + 3 × largest family + 64 MiB`; each source volume also reserves restoration space.              | Reuse coverage, space, identity, digest, and foreign-write checks. A pointer rollback alone cannot undo a database migration.                          |
| NOCOW                          | `doctor-sqlite-nocow.ts` already owns btrfs inspection, verified WAL-aware snapshots, NOCOW copies, ACL/mode preservation, integrity checks, atomic directory exchange, and retained originals. `doctor/shared/update-phase.ts` and `src/flows/doctor-health.ts` defer it during managed updates unless explicitly opted in. | Preserve that default. Add phase work/progress accounting to Doctor where required; delete the deployment-side rewrite/verifier implementation.        |
| Durable run history            | `update-run-ledger.ts`, `update-run-schema.ts`, and `update-run-recovery-store.ts` store run history and recovery descriptors in the shared state database, including phase timings and intent/observed effects.                                                                                                             | Reporting cannot be the sole authority for restoring its own database.                                                                                 |
| Independent activation journal | `package-update-activation-immutable.ts` and the immutable-pointer adapter use installation-sibling `.control/operation.sqlite`; the retained product runtime runs through sealed `recovery.mjs`.                                                                                                                            | Same-schema recovery is implemented. Compose Doctor migration evidence and forward recovery in this owner.                                             |
| Rollback                       | `update-immutable-activation.ts` restores a verified compatible predecessor or retains pending recovery; independent recovery reconciles pointer effects and verifies an already healthy generation without restart.                                                                                                         | Schema crossings still refuse before drain. Full immutable migration recovery is not implemented.                                                      |
| Readiness and status           | `update-immutable-verification.ts` verifies readiness and generation/process identity. The immutable record projection exposes prepared/pending facts, safe failure codes, retained recovery commands, and optional historical Gateway verification to CLI and protocol status.                                              | Historical accepted/restored receipts are not live health or pending-update success. Model markers and broader application acceptance remain separate. |
| Retention                      | Native transactions retain failed/unverified package/runtime backups and retire verified material through their owners. `update cleanup` has a separate, explicit migration-originals contract.                                                                                                                              | Permanent release-generation collection needs an owner-bound reference inventory. Do not repurpose migration cleanup as release-directory deletion.    |

`docs/reference/RELEASING.md` already links an **unshipped** immutable-runtime
proposal in
`.agents/skills/release-openclaw-maintainer/references/validation.md`. Its key
requirement applies here: resolve the generation before starting Node so lazy
imports stay in that generation, and keep it until its processes exit.

### Controller disposition

Classification is per responsibility; “covered” means a native contract exists,
not that the private controller currently calls it or that immutable integration
is already proven.

| Controller behavior                                        | Disposition                                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Freeze main; fetch/build for about 7 minutes while serving | **Native immutable preparation implemented.** Preserve exact selection and off-path sealed builds; build-account isolation remains.                                                                    |
| Stage sealed `releases/<sha>` and exchange `current`       | **Native install and pointer adapters implemented.** Adoption binds layout; journaled publication selects a sealed generation.                                                                         |
| Activation phases, receipts, recovery journal              | **Native immutable operation and status projection implemented.** Extend the same owner for migration evidence; do not copy controller phases.                                                         |
| Drain lease, interruption policy, blocker inspection       | **Covered lifecycle owner.** Reuse suspension/stop integration; remove vendored suspension code.                                                                                                       |
| Pointer cutover and systemd restart                        | **Integrated for matching schema contracts.** The immutable transaction calls the native service owner.                                                                                                |
| Wait for live and CPU/load waiver                          | **Readiness covered; budget integration needed.** Load may justify more observation time or an explicit unverified result, never waived identity/readiness proof.                                      |
| Doctor profiles `state-19-20`, `offline-doctor`, `+nocow`  | **Migrations covered; Team orchestration retires.** Doctor derives work from candidate schema and current stores. NOCOW remains explicit maintenance.                                                  |
| Offline WAL-aware backups                                  | **Covered.** Preserve native backup and restore evidence instead of parallel shell checks.                                                                                                             |
| Witness/inventory/precapture/NOCOW/rebinding artifacts     | **Generic evidence partly covered; import mapping needed.** Keep originals, map provenance to native receipts, recapture live custody. Do not turn every private artifact into a core format.          |
| Rollback and `--recover` sub-modes                         | **Native immutable recovery implemented for matching schema contracts.** `update recover` consumes the independent journal and retained runtime; schema-crossing forward recovery remains.             |
| Release retention/cleanup                                  | **Generic generation collection missing.** Protect active, previous, live-process and recovery references; keep migration originals under their existing owner.                                        |
| `--switch-runtime node\|bun`                               | **Team surface retires from this cutover.** Initial adoption keeps the verified Node executable; native runtime selection remains separate. Do not add another runtime-switch flag.                    |
| Manager pair adoption and private release bookkeeping      | **Team-specific; remove after one-time migration.** Core adopts verified installation facts, not Manager identities or an ongoing pair protocol.                                                       |
| Night Watch handoffs                                       | **No core dependency.** Operational approval/restart coordination remains required for Team deployment until Peter changes it; the product updater does not embed that organization-specific workflow. |
| Bash NOCOW orchestration and independent SQL verifiers     | **Team-specific duplication; delete.** Doctor is the only migration and physical-rewrite owner.                                                                                                        |

## Proposed contract

### Detect and adopt an immutable installation

Recognize an installation rooted at `/opt/<name>` with `current` selecting a
direct, sealed `releases/<sha>` child. Directory shape is only a discovery hint.
Require an updater-owned installation record binding the canonical parent,
service identity/scope/account, state/config/profile, runtime executable, source
authority, and generation build identity. Validate symlink containment, ownership,
same-filesystem atomic publication support, and absence of a competing updater
before any mutation. Foreign pointers or ambiguous services produce a named
non-outcome with the previous Gateway still running.

Use the existing installation/activation control SQLite owner for authoritative
adoption facts; package/build manifests are immutable artifact facts, not another
mutable JSON state store. Recognition precedes the Git/package fallback only for
a verified native adoption. An unadopted sealed layout must not gain write
authority from a path or package name. Do not overload the `macos-app` host marker.

Separate three identities: stable installation (`/opt/<name>`), pointer revision,
and physical generation (`releases/<full-sha>` plus artifact digest). Run/Doctor
authority includes the exact native service and selected state. Build metadata is
prepared once and carried through activation; invalidate it when its artifact
identity changes. Pointer and service observations are revalidated after awaited
work and immediately before each effect. A journal revision or token alone is not
live executor authority.

No new `openclaw.json` options are required. Normal `openclaw update`, dry run,
status, and repair should dispatch by the adopted install kind. Keep existing
channel/target selection, but freeze the chosen official revision exactly once.
An initial installer/adoption operation must be specified with the owning CLI
workflow before implementation; this draft does not advertise an existing
`--immutable` or adoption command. Routine calls then require no Manager repo.

### Prepare everything possible while the previous Gateway serves

Use the existing source preparation pipeline to fetch the configured official
source, resolve a full commit, install with its pinned package manager and frozen
lockfile, and build in private staging on the release filesystem. Never mutate the
serving generation. Do not re-resolve `main` or walk back to another SHA after
selecting the target. A retry may reuse only a candidate whose source, toolchain,
dependencies, and artifact identities still match the recorded preparation.

Run candidate admission, artifact verification, Doctor rehearsal on WAL-aware
private state copies, plugin preparation, and an isolated canary before drain.
Copies used for rehearsal do not become the live state or prove its later
contents unchanged. Finish all generated runtime/plugin artifacts before sealing;
route writable caches and state outside the release tree. Plugin payload changes
must not rewrite a sealed generation after activation.

Publish the verified candidate into `releases/<sha>` without replacing an existing
directory. If that SHA already exists with different bytes or incomplete
artifacts, report the conflict and preserve it for inspection. A runtime/toolchain
variant at the same SHA is outside the initial layout contract; no in-place rebuild
of a generation is allowed. Record source SHA, build digest, runtime identity,
schema contracts, and prepared service facts in the existing run/activation
records. Seal through filesystem permissions owned by the installation; the
Gateway account gets read/execute access, while the updater controls publication.

### Drain, migrate when required, and activate

The updater executes outside the Gateway's service cgroup. The existing executor
and native service owners hold installation authority through the following
sequence; these are conceptual substeps, not a second top-level run vocabulary.

1. Record prepared candidate and previous generation in the independent activation
   journal. Verify backup capacity and migration requirements before closing
   admission. Announce activation through the existing run notice owner.
2. Reuse the suspension coordinator through the update service-drain owner. Renew
   the request lease while draining and bind observations to the serving boot/PID.
   Readiness ends drain immediately. Existing terminal interruption policy may
   settle ordinary work, but unresolved write custody cannot be killed to satisfy
   an arbitrary 30-second target. Resume the exact lease on an aborted stop.
3. Stop through the native service owner and confirm the old process and accepted
   write work have settled. Prevent a supervisor restart during offline migration
   using the existing maintenance custody. An explicit stop followed by start is
   the migration-capable restart sequence; there is no build in `ExecStartPre`.
4. Have candidate Doctor validate fresh live requirements under maintenance
   authority. Rehearsal is not authority to overwrite later changes. Capture the
   required verified backups before mutation, run only required repairs/migrations,
   and publish typed results. On an exact, already-admitted state, do not rewrite
   stores for NOCOW or run a second full migration pass solely because of cutover.
5. Persist pointer-publication intent, including expected previous target and
   physical identities. Create a temporary relative symlink beside `current`,
   atomically rename it over `current`, and durably sync the parent through
   `directory-durability.ts`. Do not unlink `current` first. Read back the effect
   and record its observed outcome before proceeding.
6. Start through the same service owner with the stable definition preserved.
   Verify the resolved generation, new boot/PID, authenticated readiness, and
   required plugin/service facts. Commit success only from those receipts.

Only one process generation may write the selected state. This is not a
blue/green design with two Gateways opening the same databases. Optional NOCOW
work remains a separate maintenance operation; unavoidable incompatible migrations
can still require downtime, which must be estimated before stopping service.

### Keep recovery independent of the database being recovered

Extend `package-update-activation-*` and its recovery helper with a discriminated
immutable publication descriptor. Reuse durable revision/intent/observation and
identity checks; do not disguise release directories as npm package backups.
The installation-sibling control database remains outside release directories and
Doctor's state replacement set. It records retained generation and backup-manifest
references, exact service identity, pointer effects, migration completion, and the
boundary at which the candidate may accept writes. The existing shared-state run
history remains the user-facing record and is reconciled from the authoritative
operation after a state restore; never infer an aborted update from a missing row.

The current shared-ledger recovery path refuses unresolved `.openclaw-restore-*`
families. Generalizing the independent activation owner must explicitly cover
that interruption boundary before claiming immutable migration recovery. Existing
package journal readers remain versioned: do not silently reinterpret an old
pending operation with a new descriptor. The new type/schema and recovery/retention
semantics need the [storage design checkpoint](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes)
before implementation; this draft records the proposed decision, not acceptance.

On restart of the updater, reconcile the durable intent against the actual
pointer, process, database families, and recorded owner. An uncertain rename,
service action, or restore is observed before retrying. Resume only after proving
the previous executor exited and all admitted work settled. The retained recovery
helper must remain executable without the candidate or Manager checkout.

| Failure boundary                             | Recovery behavior                                                                                                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before drain                                 | Keep serving the previous release. Record failure/skip and retire only task-owned candidate material with verified custody.                                                                                                         |
| Drained but stop not committed               | Resume the exact suspension if still owned. Never resume another request's lease.                                                                                                                                                   |
| Stopped, no incompatible state changes       | Restore the previous pointer/config as permitted, restart the previous generation, and verify it before reporting `rolled-back`.                                                                                                    |
| Doctor failed before candidate startup       | Use Doctor's verified backup coverage and current write-evidence checks. Restore only if those checks permit; preserve migrated originals. Otherwise retain evidence and report the required compatible recovery action.            |
| Candidate started or foreign writes occurred | Do not rewind databases automatically. A schema-compatible prior runtime may still be usable under existing rollback checks; incompatible rollback requires explicit recovery. Preserve new writes.                                 |
| Slow or unverified startup                   | Extend observation from measured startup where appropriate. Preserve honest pending/unverified outcome and backups; a CPU/load waiver cannot create success. Current status behavior does not promise automatic later confirmation. |
| Crash during pointer or database publication | Independent journal and helper reconcile the exact effect and retained objects before start, restore, or retry. Shared-state ledger restoration cannot erase recovery authority.                                                    |

After verified success, generation collection protects the current generation,
the retained rollback generation, every live process reference, and every pending
recovery reference. Unknown references preserve material and produce a cleanup
warning. Deletion happens outside cutover and rechecks the same owner/revision
before each effect. Migration originals and operator backups retain their existing
explicit cleanup/retention contracts; adopting the installation does not authorize
deleting them. Initial generation retention keeps current plus previous after
verification, in addition to all protected references; acceptance of this policy
belongs to the design review.

### Give Doctor budgets that describe the work

Main already has size-derived inspection budgets. In
`src/infra/sqlite-readonly-worker.ts::resolveSqliteInspectionBudget`, the allowance
is `300 seconds + ceil(40 × family bytes / 32 MiB) seconds`: four copy/comparison
passes with tenfold slow-hardware headroom. `update-candidate-state.sizes.ts`
includes SQLite sidecars; aggregate inspection sums serial families.
`update-finalization-budget.ts` combines state, step, observed startup, and plugin
work. Defaults of 20-minute runner, 30-minute step, and 45-minute automatic step
in `update-run-timeouts.ts` are distinct from the private 2,400-second deadline.

For exactly **38 GiB**, the existing inspection formula yields **48,940 seconds
(13 hours 35 minutes 40 seconds)**. This is a conservative allowance, not a
measured duration, a recommended outage, or a NOCOW completion policy. The
incident says 38 GB without a byte count; do not substitute GiB as its measurement.

Reuse those budget owners and extend Doctor's phase accounting for snapshot,
rewrite, integrity verification, and publication. Estimate from measured family
bytes and conservative observed storage throughput, reserve verification/recovery
time, and report estimated work before service stop. Carry one parent deadline
and its provenance through subprocesses; a shorter hidden parent timeout must not
kill a child whose admitted size-derived allowance is longer. An explicit
operator timeout remains explicit and is reported with its recovery consequence.

Progress reports should include phase, bytes/work completed, elapsed time, and
remaining estimate. Distinguish slow progress from no progress; extension consumes
owner-observed work, not a free-running heartbeat. Cancellation joins write work
and leaves recorded recoverable state. Individual native-tool calls retain their
bounded execution contract. Do not introduce another collection of Team timeout
constants or a retry loop around an unjoined Doctor process.

Backups are verified against their own post-publication size/digest and SQLite
content evidence. A WAL checkpoint may change a source layout or size without
losing a committed page. `update-database-generations.ts` owns that distinction.
Doctor's `src/state/openclaw-agent-db-metadata-write.ts` may legitimately refresh
`schema_meta` when build/schema/agent metadata changes. Consume its write receipts;
do not demand identical metadata, and do not simply exclude all `schema_meta`
changes or foreign writes from safety checks. The two reported verifier failures
need separate regressions through the migration/recovery entry point.

### Service definition

Keep the existing system service, service account, profile, state path, port, and
approved hardening. The intended invariant is a stable launcher outside the
generation tree that resolves `current` once, validates the selected generation,
changes to its physical directory, and `exec`s the pinned external Node executable
with the physical `dist/index.js` path. Children and lazy imports inherit that
generation. Node must not keep resolving a mutable `current` path for later loads.

This is an illustrative **proposed** system-unit excerpt, not a command to install:

```ini
[Unit]
Description=OpenClaw Gateway
After=network-online.target
Wants=network-online.target
StartLimitBurst=10
StartLimitIntervalSec=300

[Service]
Type=simple
User=openclaw
Group=openclaw
WorkingDirectory=/opt/example
ExecStart=/opt/example/bin/openclaw-gateway --port 18789
Environment=OPENCLAW_STATE_DIR=/var/lib/example
EnvironmentFile=-/etc/example/gateway.env
Restart=always
RestartSec=5
RestartPreventExitStatus=78
SuccessExitStatus=0 143
KillMode=mixed
OOMPolicy=continue

[Install]
WantedBy=multi-user.target
```

The service renderer must supply `TimeoutStopSec` from the shared
`GATEWAY_SERVICE_STOP_TIMEOUT_MS` policy and preserve admitted operator overrides.
The current renderer's `TimeoutStartSec=30` is not a Gateway-ready deadline for
`Type=simple`; updater health observation needs its own size/startup-aware
allowance. Preserve the selected service environment and account; examples above
are placeholders, not new defaults for an existing installation. Do not add
Doctor, builds, or network package installation to unit pre-start hooks.

The stable launcher is packaged by OpenClaw, not another deployment controller.
Only the updater account may publish releases or change the launcher/pointer.
The Gateway account reads sealed code and writes its existing state/cache paths.
The current systemd lifecycle already requires root for system-scope mutations;
this design does not add broad sudo rights or elevate chat requests. Unprivileged
invocations retain the existing authorized handoff/guidance contract. Update
inspection must explicitly recognize the launcher-to-generation relationship;
otherwise current service-root fences will correctly refuse it.

## Migrate the current controller without two writers

The bootstrap is a one-time owner transfer, not an ordinary update from an old
driver that lacks immutable support. The lead must approve and coordinate the
actual Team restart through the current operational workflow. This lane neither
disables its scheduler nor deploys a candidate.

1. Inventory the actual controller revision, service definition, current/previous
   release targets, journals, outstanding leases, backup locations, and installed
   runtime. The supplied controller inventory is insufficient to write its import
   parser. Preserve an export and the original recovery executables.
2. Stop scheduling new controller operations and prove any active operation has
   settled. An interrupted old journal stays with its old recovery owner until
   explicitly resolved; do not translate a pending phase into a successful native
   receipt. Never overlap controller and native publication authority.
3. Prepare and verify the first immutable-capable release off-path. Import the
   settled history as provenance, retaining original artifacts. Under current
   native authority, recapture installation, process, state, and backup facts.
   Required carryover is mapped below.
4. In the approved restart window, install the stable launcher/service linkage,
   create the native installation record, and use the native transaction to
   activate and verify the capable release. Keep the previous sealed generation
   and original recovery tools through the bootstrap rollback window.
5. Prove a second update started by that installed release, plus a failure and
   recovery rehearsal. Only then remove the controller's scheduled execution,
   Manager pair-adoption dependency, private Bash/lib installation, and vendored
   suspension contract. Keep historical backup artifacts under their retention
   owner; removal of executables is not backup deletion.

| Existing state                                                 | Native handling                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Activation journal and receipts                                | Preserve original bytes; import settled phase/outcome/source references as provenance. Acquire fresh run/executor/service authority. Pending work is resolved before transfer. |
| Retained release pair                                          | Bind verified physical generations and compatibility to the native activation descriptor; a Manager pair label is not proof or authority.                                      |
| Offline backups, witnesses, inventory and precapture artifacts | Preserve paths/digests and map actual database coverage to native backup manifests. Unknown coverage remains retained and cannot authorize automatic restore.                  |
| NOCOW originals and snapshots                                  | Retain both and their associations. Verify current filesystem attributes and Doctor's current receipt/generation evidence; do not re-copy 38 GB merely to adopt.               |
| Rebinding and schema metadata evidence                         | Treat as historical evidence. Doctor recaptures current identities and records authorized metadata changes. Do not revive a stale custody token.                               |
| Runtime selection                                              | Adopt the existing verified Node executable. Runtime switching is outside the first immutable cutover.                                                                         |

No core component requires a Manager checkout or Night Watch session after
adoption. Team's deployment approval and restart coordination remain external
operational obligations, not product dependencies to remove implicitly.

## Proof matrix and rollout slices

“Updates always work” means best-effort updates with recorded outcomes, recoverable
warnings, and preservation of the previous serving installation before dangerous
mutation. It does not mean reporting success after failed readiness or promising
automatic rollback of every migrated store.

Existing published-driver coverage is in
`scripts/e2e/published-driver-update-docker.sh` and
`scripts/e2e/lib/upgrade-survivor/published-driver.mjs`, with release requirements
in [Releasing](/reference/RELEASING). It invokes the installed published updater
against a pinned candidate and verifies durable outcome, candidate identity,
service replacement, and readiness. That fixture uses a systemctl shim; it does
not prove native systemd or btrfs. Its 1,125-second total cell budget is not a
large-store performance budget. Some other survivor scenarios manually start the
Gateway and do not prove updater-owned restart.

| Cell                                       | Required observation                                                                                                                                                                                                                                                            | Owner / proof tier                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Published drivers × candidate              | Preserve existing supported-line package/git cells, recorded driver bytes and exact candidate build. Exercise markers actually set by each shipped driver.                                                                                                                      | Existing release matrix; candidate code cannot patch a pre-staging old driver.                                                                         |
| First immutable-capable release            | Old standalone layout stays unchanged until explicit adoption; settled and interrupted-controller fixtures prove owner transfer/refusal.                                                                                                                                        | Bootstrap integration; not mislabeled as native old-driver immutable support.                                                                          |
| Installed capable release × next candidate | Run actual `openclaw update`; assert target SHA/digest, durable run, pointer change, new service PID/boot, authenticated readiness, and sentinel correlation.                                                                                                                   | New immutable integration cell.                                                                                                                        |
| Same-schema, already-current, and dry run  | No optional NOCOW rewrite, no build during cutover, no unnecessary restart when unchanged; dry run creates no adoption or publication.                                                                                                                                          | Focused entry-point checks and timed integration.                                                                                                      |
| Fetch/build/admission/canary failure       | Old PID remains healthy, pointer unchanged, candidate never admitted to live state.                                                                                                                                                                                             | Candidate preparation integration.                                                                                                                     |
| Native systemd                             | Real system unit, preserved definition, updater outside service cgroup, correct account/environment, physical generation for parent and lazy child imports. Include insufficient privilege and competing service.                                                               | Isolated Linux Testbox/VM with real systemd.                                                                                                           |
| Drain and concurrency                      | Busy ordinary work, write custody, lease expiry, second updater, resident replacement, cancellation and failed stop all settle without stealing authority.                                                                                                                      | Lifecycle boundary integration.                                                                                                                        |
| Crash/restart at each effect               | Inject termination before/after durable intent, pointer rename, Doctor publication, native stop/start and terminal receipt; observe before replay.                                                                                                                              | Activation/recovery integration, deterministic fault hooks.                                                                                            |
| Migration and restore                      | WAL-bearing shared/agent stores, backup shortage, safe pre-start restore, changed config, foreign writes and post-start rollback refusal; independent journal survives shared-DB restoration.                                                                                   | Doctor/update integration.                                                                                                                             |
| Reported verifier failures                 | Checkpoint changes source/snapshot sizes; Doctor legitimately refreshes schema metadata. Recovery accepts authorized changes and rejects unrelated mutations.                                                                                                                   | Regression through Doctor plus rollback boundary.                                                                                                      |
| NOCOW and large state                      | Actual btrfs, retained ACLs/originals, unsupported exchange tool, partial copy/cancellation, throughput/progress and adequate parent/child budgets for a representative 38-GB store.                                                                                            | Separately budgeted release/performance cell; synthetic or authorized copied data.                                                                     |
| Readiness and status                       | `update-immutable-verification.ts` verifies readiness and generation/process identity. The immutable record projection exposes prepared/pending facts, safe failure codes, retained recovery commands, and optional historical Gateway verification to CLI and protocol status. | Historical accepted/restored receipts are not live health or pending-update success. Model markers and broader application acceptance remain separate. |
| Retention                                  | Current/previous/live/recovery/unknown references survive; only eligible owned generations retire after verification. Migration backups remain untouched.                                                                                                                       | Recovery/cleanup boundary.                                                                                                                             |

Keep focused regressions deterministic and cheap. Real multi-GB work, real
service boots, btrfs and crash-recovery compositions belong in release/performance
proof. Record before/after outage and phase durations from the same fixture and
storage class. The original design-only lane ran no such behavior proof; each
implementation PR must state its own executed cells and remaining gaps.

### Three proposed PRs

These are review slices, not permission to open or merge them. Prefer three;
split Doctor work into a fourth only if its independent regression warrants it.

1. **Immutable install and prepared generation.** Extend
   `src/infra/update-install-kind.ts`, `update-check.ts`,
   `update-runner-install-surface.ts`, and `src/cli/update-cli/update-command.ts`;
   reuse `update-runner-git-preflight.ts` and `update-runner-git-target.ts`.
   Add a narrow `src/infra/update-immutable-install.ts` adapter and package-owned
   stable launcher. Thread the install discriminator through shared protocol,
   status and dry-run consumers together. Cover detection, sealing, exact SHA,
   no-op, and candidate failure without publication. No activation until PR 2.
2. **Activation and independent recovery.** Extend
   `package-update-activation-schema.ts`, `package-update-activation-journal.ts`,
   `package-update-activation-paths.ts`, their recovery helper, and
   `package-update-recovery-contract.ts` with typed pointer effects. Integrate
   `update-command-service-plan.ts`, `update-command-service-drain.ts`,
   `update-command-rollback.ts`, `update-run-recovery-store.ts`, and
   `src/daemon/systemd-lifecycle.ts` / service identity inspection. Complete
   journal recovery, Doctor receipt bindings, readiness and retention as one
   flow. Add only missing NOCOW phase-budget/progress integration in Doctor and
   the existing budget owners; preserve optional deferral. No second journal or
   service controller.
3. **Adoption, proof, and controller retirement.** Add bounded import/adoption
   through the installer/update owner, release matrix cells in `scripts/e2e/`,
   and user docs under `/cli/update`, `/install/updating`, and Doctor. Document
   existing unsupported first hops and test the second native update. After
   lead-approved deployment and proof, remove the private controller's duplicate
   execution paths in its own repository. That private deletion is a separate
   authorized operational action, not an incidental public-repo change.

Generalization should leave one implementation of journal durability, suspension,
Doctor verification, and service operations. Existing released package-journal
formats retain explicit compatibility readers; immutable mode gets a typed
descriptor, not copied files with renamed prefixes. Initial scope excludes
package-manager generation conversion, runtime switching, new Gateway config
options, schema policy changes, and multi-Gateway state sharing.

## Review decisions and evidence gaps

The implemented same-schema slice does not establish the broader independent
journal migration/restore contract or the real systemd/btrfs matrix. Production
owner transfer still requires the approved deployment window and slice-3 proof.
The private controller's actual artifact schema, ownership/permissions, runtime
path, and current recovery state were not inspected in this lane.

**Original design-lane evidence:** No runtime change, production restart, performance benchmark, published-driver
cell, or immutable update was executed. Docs sanity and review results belong in
the lane handoff alongside this local draft. Do not interpret the campaign's
“Testbox-validated” heading as validation of this proposed behavior.
