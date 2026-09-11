---
summary: "Capture, reuse, refresh, and recover prepared cloud-worker images"
title: "Cloud worker warm images"
read_when: "You want later cloud dispatches to start from a prepared image, or you are recovering a paused capture."
---

How OpenClaw captures a prepared project and node runtime before enrollment, reuses that image for later workers, and how to recover a capture that was left uncertain.

## Warm images

The Crabbox plugin prepares its [supported CLI](/gateway/config-cloud-workers#crabbox-profile) automatically before warm-image operations. Keep the fixed lease ID: it prevents duplicate allocations when dispatch is retried.

Warm images and project preparation for image capture are Linux only.

On Linux, warm images are on by default when a class is known from `settings.class` or the placement's `machineClass`, unless the profile declares a nonempty `setupEnv`. With no effective class and no explicit `warmImage`, provisioning stays cold without requiring `warmImage: false`. Placement overrides are resolved before choosing this default.

Forwarded host environment values reach setup, so whatever setup derives from them could persist in a shared image. Profiles with nonempty `setupEnv` capture only when you explicitly set `settings.warmImage: true`, after checking that setup leaves no credential on disk. Explicit `true` requires a known configured or placement class before any provider command. Explicit `false` always keeps provisioning cold, for example when snapshot storage charges or provider-side retention of repository content are unwanted.

For a Gateway worktree project with a Git commit, capture happens during provisioning, before node enrollment. After profile setup, OpenClaw prepares a pristine checkout of the admitted commit and, when the dispatch caller authorizes setup, runs its committed executable `.openclaw/worktree-setup.sh` at the final workspace and `HOME` paths. It installs the verified node runtime and captures the completed environment when an image is needed. An explicit setup skip uses a separate prepared cache; without setup authority, an executable recipe keeps the existing Git-seed path. The first dispatch includes that work; subsequent sessions can reuse the image without waiting for the first session to stop. Session edits, eligible untracked files, and node enrollment credentials arrive only after capture. Repository-only sessions use the same preparation flow: OpenClaw resolves the repository instance, commit, and executable setup recipe through GitHub. Public sources fetch that exact commit on the worker without credentials. Private sources fetch authenticated Git objects into temporary Gateway storage, then transfer a verified Git pack; this preparation step never puts GitHub credentials in provider scripts, worker files, or snapshots. The Gateway creates no managed checkout and runs no project setup for this transfer. Providers without project preparation retain ordinary checkout after enrollment.

Private preparation needs temporary Gateway disk space for the shallow Git objects and outgoing pack. The existing 4 GiB pack limit applies to the transferred artifact; it does not cap bytes downloaded by Git before that pack is produced. Fetch uses a bounded command timeout, and temporary files are removed after the owning work settles, including cancellation.

Project images also retain one verified compressed worker archive in the installed runtime package, outside node identity and session state. A matching new node uses those bytes instead of downloading the worker archive again. It still enrolls normally and extracts and validates its own installation. OpenClaw worker turns prewarm the worker runtime on capable nodes; Codex remote execution skips that unused startup. If the Gateway requests a different archive, the node uses the normal authenticated download; a present but corrupt or unsafe prepared archive fails installation visibly. Preparing a replacement archive removes the superseded published archive before capture. The slim node runtime archive does not include the standalone worker payload.

Daytona requires a stopped source for filesystem snapshots. OpenClaw allows Crabbox to stop the scrubbed worker for capture. A successful capture waits for snapshot completion and restores a previously running source before project enrollment continues.

Image reuse is keyed by the backend, setup command, sorted `setupEnv` variable names (not their values), desktop setting, effective operating system, exact effective machine class, and project identity when present. Project identity comes from the Gateway's namespace and the canonical shared Git directory. Linked session worktrees from the same repository share it; a new session or commit does not create another project identity. Separate repository clones have separate identities. Prepared repository identity includes the canonical URL, GitHub repository ID, current agent binding, selected shared GitHub account/profile or explicitly verified anonymous access, and a separate scope for private contents. Tokens are never persisted in that identity. Each prepared seed also records its exact commit, so a changed commit can refresh the same project's image.

Before its first provider allocation command, OpenClaw records whether the lease starts cold or from a specific checkpoint, along with its resolved operating system and class. Retries and Gateway restart reuse that exact choice; a lost response cannot switch a cold allocation to a newly available image or select a different checkpoint. The record advances through preparation and enrollment, and a selected checkpoint remains protected from deletion until the provider confirms the lease has stopped. A failed fork reports an error instead of silently changing the recorded allocation. Runtime identity is also frozen for that allocation. Replay rejects a changed or missing identity rather than relabeling an existing worker; stop it before creating a new allocation. An older allocation cannot replace an image published from a different source generation merely because their runtime digests differ.

Warm images work on `machine0` through Crabbox's `--strategy image`; other backends keep their native checkpoint strategy. OpenClaw uses Crabbox's verified fork-readiness result for backend-specific image states, including Machine0's `ACTIVE` state. Unpinned project images refresh during preparation when the requested commit or runtime changes, or the image reaches `refreshAfter` (24 hours by default). Non-project images refresh at the next eligible worker stop when the runtime changes or after that interval. Runtime identity includes the node archive digest, execution mode, and the worker archive digest when that archive is included in the image. Images without recorded runtime identity are refreshed at the same capture boundary. An older compatible image remains a useful setup base: the first session installs the current runtime, then captures it so subsequent sessions can reuse that installation.

The current image remains recorded and usable throughout capture. By default, OpenClaw atomically records the replacement and its predecessor's deletion obligation in the same profile record, then deletes the predecessor once no allocation still needs it. With `keepPrevious: 1`, it retains the predecessor as **Previous** for rollback and retires the older previous generation first. A pinned predecessor is retained regardless of `keepPrevious`; an existing pinned previous generation is never deleted to make room. If both current and previous are pinned, OpenClaw skips replacement publication and warns once about the single-pinned-previous limit. Unpin one checkpoint to permit that replacement. Failed deletion warns, survives Gateway restart and warm reuse, and retries during periodic maintenance, later capture maintenance, or warm-image-enabled worker teardown. Further refreshes for that profile wait for deletion to succeed; replacement forks and lease teardown continue.

Allocation choice does not retry retained deletions or wait for them, including deletions for other profiles. It can select a usable replacement while its predecessor awaits deletion. If the current image itself is retiring, a new allocation selects cold provisioning. Ordinary expiry and missing-image cleanup can still run during allocation; retained deletion retries share a one-minute maintenance budget during capture, teardown, or periodic maintenance.

OpenClaw deletes unused, unpinned images after `retainUnused` (14 days by default) and reclaims the least recently used eligible image before admitting a 129th profile record. It retires eligible previous generations first when reclaiming capacity. Current and previous generations share one profile slot; deleting only a previous generation does not free that slot. Provider deletion must succeed before its ownership record is removed. Pins, pending captures, retirements, and outstanding allocations retain their slots; retirement also waits for allocations using that checkpoint to stop. If all 128 slots are retained, new warm-image allocations fail with cleanup guidance. Each profile record admits at most 256 outstanding allocations and owns its current image, an optional previous generation, and at most one capture or retirement operation. Capacity never evicts a retry choice or cleanup obligation.

While Crabbox remains enabled with a configured worker profile, the Gateway's existing maintenance loop also checks unused images about once a minute, even when no workers remain. Cleanup runs independently of allocation, retries retained deletions, and does not extend an image's last-used time. Gateway shutdown and plugin reload cancel and drain an active cleanup command before its owner stops. Maintenance tries deletions through each distinct configured executable in a fixed order and releases a record only after a deletion succeeds or every executable reports the checkpoint absent. A deletion error keeps the record for a later retry. Automatic cleanup does not reactivate removed or disabled providers.

Before capture, OpenClaw removes per-lease worker identities, device tokens, and session state, including node-host workspaces and SSH-transport workspaces under `~/.openclaw-worker/workspaces`. Machine-level caches intentionally survive: npm caches, content-addressed node runtime and worker bundle installs under `~/.openclaw-worker`, and pristine Git seeds under `~/.openclaw-worker/git-seeds`. Project preparation starts with immutable Git content. Completed setup may retain ignored dependency/build output and change eligible source files; OpenClaw keeps separate pristine and completed manifests. A fresh dedicated node verifies that completion and binds the fixed workspace and `HOME` to one session. Initial project sync applies session changes relative to the pristine commit onto the completed setup, preserving setup-generated files and tracked setup edits that the session did not change. Session edits take precedence on changed paths. After a turn, reconciliation carries eligible generated output back to the Gateway. Accepted reconciliation results and explicit checkpoint restores apply their exact snapshots, including deletions of setup-generated files. A different session cannot claim that binding, and retirement leaves a permanent tombstone even after workspace files are removed. Images also retain whatever `settings.setup` wrote elsewhere, so keep setup credential-free and enable reuse only for mutually trusted workloads.

Scrubbing has a three-minute timeout. Checkpoint creation requests `--wait --wait-timeout 2700000ms`, matching Crabbox's 45-minute native-capture budget before enrollment. On Daytona, source preparation and stopping share that budget with snapshot creation and readiness. A successful waited capture is recorded as available and can be reused without another availability inspection. The command deadline adds three minutes for command overhead, plus separate source lifecycle time: three minutes for Daytona recovery or two default 15-minute Machine0 stop/restore windows. Provisioning and teardown deadlines also cover capture maintenance, scrubbing, and child-process settlement. These limits do not grant another capture attempt. Scrub failure releases only its own capture reservation. Once creation starts, failure, timeout, or unusable output leaves its outcome uncertain: the profile stays paused until explicit recovery. The exception is a complete, normally exited `not_submitted` failure receipt from Crabbox for the same provider and lease, confirming that its local reservation was removed. OpenClaw then clears only that capture reservation. Provisioning still fails and stops the source lease because the receipt does not prove that source rollback succeeded. Optional teardown captures warn without failing successful source-lease cleanup. An unresolved project capture prevents node enrollment on that source, so fresh node credentials cannot enter a capture that may still be running. Lease cleanup still runs, and a retained usable image can serve new allocations. Capture needs a Crabbox CLI and backend that support fixed-ID checkpoint forks. Continuing a coordinator-retained `checkpoint_pending` response requires the CLI repair in [Crabbox #1698](https://github.com/openclaw/crabbox/pull/1698); older binaries can accept `--wait` and still fail on that response. Correct missing capabilities or permissions before recovering an uncertain capture.

A warm start provisions a fresh lease with fresh node enrollment. Cold allocations and snapshot forks use the same configured lease lifetime, idle timeout, desktop setting, and public networking without Tailscale. A warm start reuses machine-level caches, not a per-session snapshot or a suspended process.

Project preparation checks for a verified completed checkout and pristine seed before building or uploading a Git pack. Reusing the same commit skips clone and setup. A changed Gateway-project commit refreshes the existing checkout with a thin Git transfer, removes obsolete eligible setup outputs, and reruns its admitted recipe while preserving compatible ignored caches and absolute paths. Tracked paths in the new commit take precedence over conflicting cache files or directories; unrelated ignored caches and the prepared `HOME` remain in place. If the Gateway has garbage-collected the previous commit after rewriting history, it transfers a full snapshot of the current commit while keeping the verified remote workspace and caches. Completion is invalidated before mutation, so interrupted setup cannot advertise readiness or silently rerun. Before enrollment, replay of an already allocated prepared worker conservatively captures its completed setup when it still owns the current source image. This can add one snapshot if an already-complete warm reuse was interrupted before enrollment; a published replacement and enrolled-session replay do not capture again. An enrolled provisioning retry only inspects the original completion witness; it never runs setup or captures a session. Already-bound session restart preserves user edits through the stored binding. Placements without a completed checkout retain the existing flow: copy the seed's Git objects into a fresh repository, recreate its Git metadata, and apply the current eligible file manifest. A matching seed skips both an origin fetch and a full Git pack download, including for private or unpublished commits. A missing seed uses the Gateway pack; an invalid prepared seed fails visibly. Workspaces without a prepared project keep the eligible origin/seed path. The Gateway builds transfer packs only on demand, and each transfer retains its original base commit even if local commits change later.

### Retention policy

Set the plugin-wide policy under `plugins.entries.crabbox.config.warmImages`, or
use the **Retention policy** card in **Snapshots**. Changes take effect after a
Gateway restart; they do not change worker lease lifetimes or the 128-profile
capacity limit.

| Key            | Default | Accepted values                                                   |
| -------------- | ------- | ----------------------------------------------------------------- |
| `refreshAfter` | `24h`   | Whole minutes, hours, or days (`m`, `h`, `d`), at least `1h`.     |
| `retainUnused` | `14d`   | Whole minutes, hours, or days (`m`, `h`, `d`), at least `1d`.     |
| `keepPrevious` | `0`     | `0` retires replaced images; `1` retains one previous generation. |

Duration values accept one to eight digits followed by one unit, such as `90m`
or `14d`; composite and fractional durations are invalid.

```json5
{
  plugins: {
    entries: {
      crabbox: {
        config: {
          warmImages: {
            refreshAfter: "24h",
            retainUnused: "14d",
            keepPrevious: 1,
          },
        },
      },
    },
  },
}
```

Pinned checkpoints are exempt from age refresh, unused expiry, capacity eviction,
and replacement retirement. For prepared project images, a pin keeps a checkpoint
available, but a runtime or recipe change still starts new workers cold until a
compatible capture publishes.
Other allocation compatibility rules also remain unchanged. A newer capture for
the same profile record moves a pinned current checkpoint to **Previous**, even
with `keepPrevious: 0`; rollback can restore it. Unpinning restores ordinary
policy at the next maintenance pass or capture boundary. Previous generations
can expire when unused, and lowering `keepPrevious` to `0` permits their
retirement unless pinned or still held by an allocation.

### Ready workers

For an eligible local Git project or repository-only session, a successful session activation can prepare a
dedicated worker for the next session in the background. The default target is
one unassigned worker per project and profile, with a Gateway-wide cap of four.
The next matching dispatch consumes a ready worker once, then schedules refill;
if no eligible worker is ready, dispatch uses ordinary provisioning.
Paired-device dispatch does not use this pool.
Repository admission, refill, and restart binding recheck current source access and visibility. Public and private repositories use separate preparation identities; a visibility change or lost access prevents reuse of earlier prepared capacity. Retention and cleanup use local ownership facts without requiring GitHub access. A changed repository instance or selected account cannot consume capacity prepared for the previous owner.
A ready-worker hit bypasses provisioning. A foreground miss uses ordinary
snapshot refresh and may wait for a required capture before enrollment; disabling
reserves preserves that refresh behavior.

**Build on demand.** Call `environments.prepare` with `{ profileId, projectPath }`
and `operator.admin` scope to prepare the local Git checkout's `HEAD` without a
session. The profile must support project preparation. This authorizes the
committed project setup recipe and returns `{ environmentId, preparationKey,
reused }`; a matching live, unconsumed build or reserve is reused. An unfinished
reserve becomes a build without renewing its expiry. A build can finish
when `readyWorkers` is zero, but admission still requires room under
`preparedPool.maxTotal`. Once ready, ordinary reserve policy keeps it or retires
it as surplus on the next pool pass. Its demand starts the normal refill and
provider idle-timeout window. Track its `preparation: { purpose, key }` in
`environments.list` or `environments.status`; `environments.destroy` cancels it
and waits for provider work to settle and cleanup to finish.

Set `cloudWorkers.profiles.<id>.readyWorkers` to change the per-project target and
`cloudWorkers.preparedPool.maxTotal` to change the shared cap. Zero disables the
corresponding reserves and drains unused capacity while preserving active
sessions and image reuse. Preparing workers and workers awaiting confirmed
cleanup count against the limits. Ready workers incur running-machine charges
until the provider confirms deletion.

Each reserve expires from the successful activation or explicit build that
created its demand, using the provider's existing idle timeout. Refill and Gateway restart do not
extend that window. An already-admitted capture can finish within its provider
budget after expiry, while its worker remains counted. Expiry blocks subsequent
enrollment, readiness, and consumption; cleanup follows settled capture custody.
Provider TTL and idle-timeout settings remain unchanged. A failed dispatch does
not create fresh demand. Claiming a worker and assigning its placement commit
together; failed attachment or placement deletion cannot make that worker
available to another session.
Expired, disabled, incompatible, and surplus workers are cleaned up without
waiting for unrelated project preparation.

Prepared-project images record foreground demand only after successful session
activation. Failed enrollment or dispatch does not renew image demand. A newly
captured image stays protected by its producing worker until confirmed source
stop; without successful demand, it is then eligible for ordinary cleanup.

Crabbox reserves require an eligible dedicated Linux warm-image profile, a known
machine class, and immutable setup inputs without `setupEnv`. A changed cache
identity may require cold preparation. The project recipe and normal runtime
installation still complete before readiness, but that cold worker cannot
replace an unrelated image generation. This can reduce snapshot reuse until an
eligible generation can publish; it does not permit incomplete setup or extend
an older image's demand window.

### Inspect snapshots in the Control UI

Open **Settings → Connections → Cloud workers → Snapshots** to inspect local
warm-image ownership, grouped by configured profile. **Refresh** reloads both
snapshots and worker builds. While a build or capture is in progress, both lists
refresh every 10 seconds; polling stops when neither remains active.
The view shows available images, captures in progress, images held by outstanding
allocations, and captures or checkpoint deletions that need attention. Pending
deletions show the checkpoint and retry guidance; a retiring current image is
labeled **Retiring**, while an available successor keeps its status when only
an older image awaits cleanup. Group headers prefer recorded
machine facts and fall back to the configured profile's backend, class, and
operating system. Missing row details are omitted; unknown profile IDs appear
under **Unlabeled profile**. Legacy allocations appear under
**Needs migration** with Doctor recovery guidance.

The Crabbox plugin advertises `crabbox.images.list`, `crabbox.images.recover`,
`crabbox.images.pin`, `crabbox.images.delete`, and `crabbox.images.rollback`;
all require `operator.admin`. Each action appears only when its method is
advertised. If the listing method is not advertised, the view
explains that the Crabbox worker provider must be enabled. Listing reads local
state without contacting the provider and returns an allocation count plus at
most 20 allocation entries per image.

**Pin** and **Unpin** apply immediately and show a failure notification if the
request is rejected. A **Pinned** badge marks protected checkpoints. A pin is an
operator choice; **Held** means an outstanding allocation still needs the
checkpoint. Pin changes are unavailable while the profile has a capture or
retirement operation, so they cannot race provider side effects.

**Delete** asks for confirmation and is disabled with a reason when the image is
held, capturing, or pinned. OpenClaw retains the ownership record until provider
deletion succeeds. A failed deletion leaves the image **Retiring** and retries
during maintenance; it does not report the checkpoint as deleted.

When a previous generation exists, its **Previous** line shows the checkpoint
and creation time, with **Pin** or **Unpin** and **Roll back** actions. Confirming
**Roll back** atomically restores that checkpoint as current. The demoted current
image becomes previous when `keepPrevious: 1` or when it is pinned; otherwise it
is retired after allocations release it. Rollback therefore still works after
lowering `keepPrevious` to `0`, while the previous checkpoint remains recorded.
A profile with an active capture or retirement cannot roll back.

The **Retention policy** card at the bottom edits the three plugin-owned keys
above through the normal configuration patch flow. Saving validates their
durations and generation count; restart the Gateway to apply the policy.

**Build snapshot** opens a profile and local repository picker when
`environments.prepare` is available with `operator.admin`. The repository catalog
is shared with New Session. Profiles with warm images off are disabled with their
reason. Building prepares the selected checkout's committed `HEAD` and authorizes
its committed setup recipe without starting a session. The notice distinguishes a
new build from reuse of an existing build or reserve. A full pool requires raising
the prepared pool cap or destroying an unused worker before retrying.

**Rebuild** uses the project root recorded on a project image. Older images without
a recorded root omit this action; use **Build snapshot** to select the repository.
Rebuild uses the normal preparation and image refresh policy, including reuse of
matching work already in progress; it does not force replacement of a current image.

Active builds appear in their configured profile group with worker state and age.
**Cancel** asks for confirmation, then calls `environments.destroy` and waits for
provider work and cleanup to settle. Completed or attached workers no longer appear
as active builds. The **Building** total also includes active image captures,
counting a build and its capture once when they share a lease ID.
Failed and orphaned builds remain visible with their reported error and count
toward **Needs attention**. They do not keep polling active or offer cancellation.

**Recover** is available only for uncertain captures. Its required checkbox
acknowledges that the owning capture and worker have stopped and provider
artifacts have been reconciled, with the same meaning as the CLI's
`--acknowledge-provider-cleanup`. Follow the cleanup steps below before confirming.
Recovery clears only the selected reservation; it does not stop a worker or
delete provider artifacts. A stale capture alone does not permit recovery.

New allocations record optional `profileId`, `backend`, `machineClass`, `os`,
`projectLabel`, and `projectRoot` display facts, also included in `openclaw crabbox warm-images --json`.
The JSON output also includes optional `pinned` metadata (`atMs`) and `previous`
checkpoint details (`checkpointId`, `createdAtMs`, and recorded `baseCommit` and
`runtimeIdentity`). Existing version-3 rows without these fields remain unpinned
with no retained previous generation; no state migration is needed for them.
`profileId` means the configured profile that most recently allocated from the
image key; it is overwritten on each allocation and does not change image keys
or reuse policy. `projectRoot` is the Gateway-local checkout root used for rebuilding.
Project labels use the normalized origin repository identity
`host/owner/repo`, or the project root's basename when origin cannot be resolved.

### Recover a paused capture

Inspect local ownership without contacting the cloud:

```bash
openclaw crabbox warm-images --json
```

The bounded status includes checkpoint IDs, project keys, recorded runtime identity, allocation choices and phases, capture selectors, source lease IDs, backend names, and timestamps; it does not include setup commands or environment values. Doctor reports pending captures and retirements but never clears them through `doctor --fix`. A capture older than 20 minutes produces a warning and can still be preparing its source or waiting for provider readiness; allow the owning capture to settle. Only an explicitly uncertain outcome carries mandatory recovery guidance. Elapsed time does not grant permission to take over. The same reservation remains authoritative across restarts; older empty reservation markers also require explicit recovery. If inspection asks for a migration, follow [Upgrade warm-image state](/gateway/cloud-workers/warm-images#upgrade-warm-image-state) first.

Before recovery, stop the owning Gateway, any original capture processes, and the recovered worker. Use the source lease and capture time to reconcile the uncertain operation in Crabbox's checkpoint catalog, and resolve any untracked provider artifact. Only after those steps, copy the exact capture selector from status:

```bash
openclaw crabbox warm-images --recover <capture-selector> --acknowledge-provider-cleanup
```

The acknowledgement attests that the original capture and worker are stopped and untracked artifacts are resolved; elapsed time alone does not establish those facts. Recovery clears only that capture reservation, preserves known checkpoint references and allocation choices, and rejects a replaced selector. It does not stop processes, run provider commands, delete snapshots, or allocate a worker. Restart the Gateway afterward; the next eligible worker can capture again. Failed checkpoint retirements retry during later capture maintenance or warm-image-enabled worker teardown after provider deletion errors are resolved; they do not use capture recovery.

### Upgrade warm-image state

Warm profiles use a version-3 envelope in the existing `warm-images` plugin-state namespace; the SQLite schema version does not change. Stop the owning Gateway and original capture processes, then run:

```bash
openclaw doctor --fix
```

Doctor performs this migration under the Gateway's exclusive maintenance lock. It preserves legacy image metadata, allocation choices, operating-system/runtime identity, capture selectors, and retirement obligations. Historical records do not acquire preparation, reserve-purpose, or successful-demand facts. Older empty capture markers become explicitly uncertain captures with their original recovery selector. Unsupported records stay unchanged and produce a warning. Runtime provisioning requires the canonical envelope; it does not silently convert old rows.

Older `warm-leases` rows record an enrolled class but cannot establish whether a lease originally started cold or from a checkpoint. These rows block new warm-image allocations until resolved. Doctor reports their count and exact recovery commands. Resolve each lease through its original Gateway or provider, stop its worker and owning processes, and reconcile provider artifacts before using the reported selector:

```bash
openclaw crabbox warm-images --recover <legacy-allocation-selector> --acknowledge-provider-cleanup
openclaw doctor --fix
```

This recovery deletes only the unchanged legacy row matching that selector. It does not establish provider absence or clean up a machine for you. Keep the row when cleanup is uncertain. Checkpoints already forgotten by older code are not rediscovered; reconcile those manually through Crabbox. Do not run older and newer writers against the same state or downgrade while allocations, captures, or retirements remain unresolved.
