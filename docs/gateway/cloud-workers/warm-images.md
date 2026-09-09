---
summary: "Capture, reuse, refresh, and recover prepared cloud-worker images"
title: "Cloud worker warm images"
read_when: "You want later cloud dispatches to start from a prepared image, or you are recovering a paused capture."
---

How OpenClaw captures a prepared project and node runtime before enrollment, reuses that image for later workers, and how to recover a capture that was left uncertain.

## Warm images

Use [Crabbox 0.49.1](https://github.com/openclaw/crabbox/releases/tag/v0.49.1) or newer for coordinator-backed warm images. Older binaries can complete a cold start but reject a later `checkpoint fork --lease-id`; update the binary used by the Gateway before starting the profile. Keep the fixed lease ID: it prevents duplicate allocations when dispatch is retried.

Warm images and project preparation for image capture are Linux only.

On Linux, warm images are on by default when a class is known from `settings.class` or the placement's `machineClass`, unless the profile declares a nonempty `setupEnv`. With no effective class and no explicit `warmImage`, provisioning stays cold without requiring `warmImage: false`. Placement overrides are resolved before choosing this default.

Forwarded host environment values reach setup, so whatever setup derives from them could persist in a shared image. Profiles with nonempty `setupEnv` capture only when you explicitly set `settings.warmImage: true`, after checking that setup leaves no credential on disk. Explicit `true` requires a known configured or placement class before any provider command. Explicit `false` always keeps provisioning cold, for example when snapshot storage charges or provider-side retention of repository content are unwanted.

For a Gateway worktree project with a Git commit, capture happens during provisioning, before node enrollment. After profile setup, OpenClaw prepares a pristine checkout of the admitted commit, installs the verified node runtime, and captures the machine when an image is needed. The first dispatch includes that work; subsequent sessions can reuse the image without waiting for the first session to stop. Session edits, eligible untracked files, and node enrollment credentials arrive only after capture. Repository-only sessions have no Gateway project checkout to prepare; they use machine/runtime image reuse and node Git seeds, with image capture at an eligible enrolled worker's teardown.

Project images also retain one verified compressed worker archive in the installed runtime package, outside node identity and session state. A matching new node uses those bytes instead of downloading the worker archive again. It still enrolls normally and extracts and validates its own installation. OpenClaw worker turns prewarm the worker runtime on capable nodes; Codex remote execution skips that unused startup. If the Gateway requests a different archive, the node uses the normal authenticated download; a present but corrupt or unsafe prepared archive fails installation visibly. Preparing a replacement archive removes the superseded published archive before capture. The slim node runtime archive does not include the standalone worker payload.

Daytona requires a stopped source for filesystem snapshots. OpenClaw allows Crabbox to stop the scrubbed worker for capture. A successful capture waits for snapshot completion and restores a previously running source before project enrollment continues.

Image reuse is keyed by the backend, setup command, sorted `setupEnv` variable names (not their values), desktop setting, effective operating system, exact effective machine class, and project identity when present. Project identity comes from the Gateway's namespace and the canonical shared Git directory. Linked session worktrees from the same repository share it; a new session or commit does not create another project identity. Separate repository clones have separate identities. Each prepared seed also records its exact commit, so a changed commit can refresh the same project's image.

Before its first provider allocation command, OpenClaw records whether the lease starts cold or from a specific checkpoint, along with its resolved operating system and class. Retries and Gateway restart reuse that exact choice; a lost response cannot switch a cold allocation to a newly available image or select a different checkpoint. The record advances through preparation and enrollment, and a selected checkpoint remains protected from deletion until the provider confirms the lease has stopped. A failed fork reports an error instead of silently changing the recorded allocation. Runtime identity is also frozen for that allocation. Replay rejects a changed or missing identity rather than relabeling an existing worker; stop it before creating a new allocation. An older allocation cannot replace an image published from a different source generation merely because their runtime digests differ.

Warm images work on `machine0` through Crabbox's `--strategy image`; other backends keep their native checkpoint strategy. OpenClaw uses Crabbox's verified fork-readiness result for backend-specific image states, including Machine0's `ACTIVE` state. Project images refresh during preparation when the requested commit or runtime changes, or the image is at least 24 hours old. Non-project images refresh at the next eligible worker stop when the runtime changes or after 24 hours. Runtime identity includes the node archive digest, execution mode, and the worker archive digest when that archive is included in the image. Images without recorded runtime identity are refreshed at the same capture boundary. An older image remains a useful setup base: the first session installs the current runtime, then captures it so subsequent sessions can reuse that installation.

The previous image remains recorded and usable throughout capture. OpenClaw atomically records the replacement and its predecessor's deletion obligation in the same profile record. It deletes the predecessor once no allocation still needs it. Failed deletion warns, survives Gateway restart and warm reuse, and retries during periodic maintenance, later capture maintenance, or warm-image-enabled worker teardown. Further refreshes for that profile wait for deletion to succeed; replacement forks and lease teardown continue.

Allocation choice does not retry retained deletions or wait for them, including deletions for other profiles. It can select a usable replacement while its predecessor awaits deletion. If the current image itself is retiring, a new allocation selects cold provisioning. Ordinary expiry and missing-image cleanup can still run during allocation; retained deletion retries share a one-minute maintenance budget during capture, teardown, or periodic maintenance.

OpenClaw deletes unused, unpinned images after 14 days and reclaims the least recently used eligible image before admitting a 129th profile record. Provider deletion must succeed before its ownership record is removed. Pending captures, retirements, and outstanding allocations retain their slots; retirement also waits for allocations using that checkpoint to stop. If all 128 slots are retained, new warm-image allocations fail with cleanup guidance. Each profile record admits at most 256 outstanding allocations and owns at most its current image plus one capture or predecessor retirement. Capacity never evicts a retry choice or cleanup obligation.

While Crabbox remains enabled with a configured worker profile, the Gateway's existing maintenance loop also checks unused images about once a minute, even when no workers remain. Cleanup runs independently of allocation, retries retained deletions, and does not extend an image's last-used time. Gateway shutdown and plugin reload cancel and drain an active cleanup command before its owner stops. Maintenance tries deletions through each distinct configured executable in a fixed order and releases a record only after a deletion succeeds or every executable reports the checkpoint absent. A deletion error keeps the record for a later retry. Automatic cleanup does not reactivate removed or disabled providers.

Before capture, OpenClaw removes per-lease worker identities, device tokens, and session state, including node-host workspaces and SSH-transport workspaces under `~/.openclaw-worker/workspaces`. Machine-level caches intentionally survive: npm caches, content-addressed node runtime and worker bundle installs under `~/.openclaw-worker`, and pristine Git seeds under `~/.openclaw-worker/git-seeds`. Project preparation supplies only immutable Git content; the new session receives its own workspace and current file overlay after enrollment. Images also retain whatever `settings.setup` wrote elsewhere, so keep setup credential-free and enable reuse only for mutually trusted workloads.

Scrubbing has a three-minute timeout. Checkpoint creation requests `--wait` so Crabbox can follow the exact pending capture through provider recovery and availability before enrollment. A successful waited capture is recorded as available and can be reused without another availability inspection. The whole command still has a separate three-minute timeout, extended to ten minutes on `machine0` because capture stops and restores the source. These limits include submission and waiting; they do not grant another capture attempt. Provisioning and teardown deadlines cover their provider-owned phases. Scrub failure releases only its own capture reservation. Once creation starts, failure, timeout, or unusable output leaves its outcome uncertain: the profile stays paused until explicit recovery. The exception is a complete, normally exited `not_submitted` failure receipt from Crabbox for the same provider and lease, confirming that its local reservation was removed. OpenClaw then clears only that capture reservation. Provisioning still fails and stops the source lease because the receipt does not prove that source rollback succeeded. Optional teardown captures warn without failing successful source-lease cleanup. An unresolved project capture prevents node enrollment on that source, so fresh node credentials cannot enter a capture that may still be running. Lease cleanup still runs, and a retained usable image can serve new allocations. Capture needs a Crabbox CLI and backend that support fixed-ID checkpoint forks. Continuing a coordinator-retained `checkpoint_pending` response requires the CLI repair in [Crabbox #1698](https://github.com/openclaw/crabbox/pull/1698); older binaries can accept `--wait` and still fail on that response. Correct missing capabilities or permissions before recovering an uncertain capture.

A warm start provisions a fresh lease with fresh node enrollment. Cold allocations and snapshot forks use the same configured lease lifetime, idle timeout, desktop setting, and public networking without Tailscale. A warm start reuses machine-level caches, not a per-session snapshot or a suspended process.

Project preparation checks for the exact pristine seed before building or uploading a Git pack. After enrollment, workspace synchronization copies only the seed's Git objects into a fresh repository, recreates its Git metadata, and applies the current session's eligible file manifest. A matching seed skips both an origin fetch and a full Git pack download, including for private or unpublished commits. A missing seed uses the Gateway pack; an invalid prepared seed fails visibly. Workspaces without a prepared project keep the eligible origin/seed path. The Gateway builds transfer packs only on demand, and each transfer retains its original base commit even if local commits change later.

### Recover a paused capture

Inspect local ownership without contacting the cloud:

```bash
openclaw crabbox warm-images --json
```

The bounded status includes checkpoint IDs, project keys, recorded runtime identity, allocation choices and phases, capture selectors, source lease IDs, backend names, and timestamps; it does not include setup commands or environment values. Doctor reports pending captures and retirements but never clears them through `doctor --fix`. A capture older than 20 minutes produces a warning, not permission to take over. The same reservation remains authoritative across restarts; older empty reservation markers also require explicit recovery. If inspection asks for a migration, follow [Upgrade warm-image state](/gateway/cloud-workers/warm-images#upgrade-warm-image-state) first.

Before recovery, stop the owning Gateway, any original capture processes, and the recovered worker. Use the source lease and capture time to reconcile the uncertain operation in Crabbox's checkpoint catalog, and resolve any untracked provider artifact. Only after those steps, copy the exact capture selector from status:

```bash
openclaw crabbox warm-images --recover <capture-selector> --acknowledge-provider-cleanup
```

The acknowledgement attests that the original capture and worker are stopped and untracked artifacts are resolved; elapsed time alone does not establish those facts. Recovery clears only that capture reservation, preserves known checkpoint references and allocation choices, and rejects a replaced selector. It does not stop processes, run provider commands, delete snapshots, or allocate a worker. Restart the Gateway afterward; the next eligible worker can capture again. Failed checkpoint retirements retry during later capture maintenance or warm-image-enabled worker teardown after provider deletion errors are resolved; they do not use capture recovery.

### Upgrade warm-image state

Warm profiles use a version-2 envelope in the existing `warm-images` plugin-state namespace; the SQLite schema version does not change. Stop the owning Gateway and original capture processes, then run:

```bash
openclaw doctor --fix
```

Doctor performs this migration under the Gateway's exclusive maintenance lock. It preserves legacy image metadata, capture selectors, and retirement obligations, but does not invent allocation choices. Older empty capture markers become explicitly uncertain captures with their original recovery selector. Unsupported records stay unchanged and produce a warning. Runtime provisioning requires the canonical envelope; it does not silently convert old rows.

Older `warm-leases` rows record an enrolled class but cannot establish whether a lease originally started cold or from a checkpoint. These rows block new warm-image allocations until resolved. Doctor reports their count and exact recovery commands. Resolve each lease through its original Gateway or provider, stop its worker and owning processes, and reconcile provider artifacts before using the reported selector:

```bash
openclaw crabbox warm-images --recover <legacy-allocation-selector> --acknowledge-provider-cleanup
openclaw doctor --fix
```

This recovery deletes only the unchanged legacy row matching that selector. It does not establish provider absence or clean up a machine for you. Keep the row when cleanup is uncertain. Checkpoints already forgotten by older code are not rediscovered; reconcile those manually through Crabbox. Do not run older and newer writers against the same state or downgrade while allocations, captures, or retirements remain unresolved.
