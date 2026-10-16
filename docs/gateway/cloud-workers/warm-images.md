---
summary: "Capture, reuse, refresh, and recover prepared cloud-worker images"
title: "Cloud worker warm images"
read_when: "You want later cloud dispatches to start from a prepared image, or you are recovering a paused capture."
doc-schema-version: 1
---

OpenClaw saves a prepared repository as a snapshot so later cloud sessions can reuse its dependencies and tools. The first session prepares its own machine; later sessions fork the snapshot or adopt an already-running ready worker.

## Warm images

Snapshots are enabled by default for Linux when the profile or session selects a machine class. Setup secrets do not disable them. Without a class, automatic selection stays cold; explicit `settings.warmImage: true` requires a class. Set `false` to disable capture and reuse. macOS and Windows always start cold. Snapshots incur provider storage charges and retain repository content and machine caches, so share them only between mutually trusted workloads.

### First session for a repository

For an eligible repository with committed content, OpenClaw:

1. Provisions the session's machine and runs optional profile setup.
2. Prepares the selected commit and its [repository environment recipe](/gateway/cloud-workers/environment-file), with a verified Node toolchain and the current OpenClaw runtime.
3. Removes worker identity and session state, then fixes the snapshot capture point before node enrollment.
4. Enrolls the node, binds the session workspace, runs post-create/start commands, and starts the first turn.

With Crabbox 0.79.0 or newer on AWS, the first session continues to enrollment once Crabbox confirms the capture point is fixed. The snapshot upload finishes in the background; later sessions start cold until it is available. Older Crabbox, refresh captures, reserves, and other backends still wait for completion. Daytona may stop and restore the source machine during capture.

This works for both Gateway checkouts and repository-only GitHub sessions. Only committed repository content enters preparation. Session edits and enrollment credentials arrive after the capture point is fixed. Private repository preparation transfers Git content without putting GitHub credentials in worker files or snapshots; it needs temporary Gateway disk space, and the outgoing pack is limited to 4 GiB.

Setup-generated dependencies and build output survive into the session. Session changes are applied over that prepared content, with session edits taking precedence. Explicit checkpoint restores and accepted reconciliation snapshots retain their exact contents, including deletions.

An empty committed workspace uses the profile's shared runtime image instead of a repository snapshot. With no prepared project, capture happens at eligible worker teardown. A failed detected dependency install skips capture and lets the session start cold; a failed declared recipe stops dispatch. Explicitly skipped setup has a separate snapshot identity.

### Later sessions and refresh

A matching ready worker skips provisioning. Otherwise, a compatible snapshot starts a new machine and New Session shows **Starting from snapshot…**. The fork updates its checkout to the requested commit and installs the current runtime when needed before enrollment. Profile setup is already captured; post-create/start commands run after session binding.

Snapshot compatibility covers the repository and source-access scope, backend, exact machine class, operating system, desktop setting, profile setup command, setup-secret names and store references, repository recipe, and whether setup was skipped. Linked worktrees of one local repository share snapshots; separate clones do not. Repository-only sources also bind their repository instance, agent and selected GitHub identity. A changed recipe, machine configuration, or source-access scope needs compatible preparation, usually a cold build. Secret values and temporary sentinels never participate in the key.

The OpenClaw runtime is separate from snapshot compatibility. Gateway updates, runtime archives, enabled plugins, execution mode, profile names, lease durations, and reserve limits do not invalidate an otherwise compatible snapshot. Ready workers, however, must match the current runtime, profile, and commit before use.

A foreground fork can refresh a changed commit or top up its runtime without capturing a replacement just for that change. Background reserves and explicit builds can publish refreshed snapshots. Initial capture, interrupted capture recovery, required setup repair, and age refresh still use the capture boundary. Unpinned images become eligible for refresh after `refreshAfter` (24 hours by default); runtime-only images refresh at eligible teardown. Disabling reserves also disables automatic background refresh.

Retries and Gateway restarts keep the originally selected cold allocation or checkpoint. A failed fork reports an error rather than silently allocating another machine. Missing, retiring, or incompatible snapshots cause new allocations to start cold.

If the backend definitively refuses native capture, OpenClaw records the reason and continues enrollment on the prepared machine. Existing compatible snapshots remain usable. Capture is retried after `refreshAfter`; a successful capture clears the refusal. An uncertain capture instead pauses further capture and blocks enrollment on its source until [recovery](/gateway/cloud-workers/warm-images#recover-a-paused-capture).

### Capture lifetime

A 45-minute checkpoint wait is an operation budget, not extra lease lifetime. Before source-dependent capture, OpenClaw checks the effective remaining total lifetime and keeps the existing source heartbeat active while the provider requires the source. Heartbeats protect idle time only. If the source needs more total lifetime, OpenClaw requests a bounded `crabbox extend <lease-id> --ttl <desired-total> --json`, within the configured duration and effective maximum. Extension does not reset idle time. On the supported nonblocking AWS path, fixing the capture point permits enrollment while upload continues; lifetime checks do not turn that upload into a blocking wait. Renewal stops before source release, and allocation holds remain until cleanup is confirmed.

Crabbox owns extension authority, policy, and budget. `lease_extension_denied` and `lease_extension_budget_exceeded` grant no extra time; `lease_extension_not_advancing` means the target or cap cannot advance, and `lease_not_active` cannot revive the lease. Creation-fixed providers, including Daytona, return `lease_extension_unsupported_provider` and need sufficient TTL at creation. OpenClaw visibly skips an optional capture when the source window cannot be secured; required project capture fails preparation with that reason. It does not bypass policy, switch providers, or chain leases indefinitely.

A direct extension can commit a longer provider deadline but fail to refresh the guest expiry guard. That is a failed preparation outcome until reconciled: the guest can still shut down at its old deadline. Retry only the same fixed total TTL in the same Crabbox state to repair the pending refresh; do not add another duration blindly. See [Crabbox extend](https://crabbox.sh/commands/extend.html).

### Retention policy

Set the plugin-wide policy under `plugins.entries.crabbox.config.warmImages`, or
use **Advanced → Snapshot retention** under **Cloud environments**. These controls
apply to all repositories. Saving reloads the Crabbox plugin without restarting
the Gateway. Worker lease lifetimes and the 128-profile capacity limit stay
unchanged. Unused, unpinned images expire after `retainUnused`; images held by allocations wait for those workers to stop. Replaced snapshots retire after allocations release them unless retained as a previous generation or pinned. Failed deletion stays pending and retries during maintenance.

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
available across runtime updates; workers top up the runtime after forking it. A
recipe change still starts workers cold until a compatible capture publishes.
Other allocation compatibility rules also remain unchanged. A newer capture for
the same profile record moves a pinned current checkpoint to **Previous**, even
with `keepPrevious: 0`; rollback can restore it. Unpinning restores ordinary
policy at the next maintenance pass or capture boundary. Previous generations
can expire when unused, and lowering `keepPrevious` to `0` permits their
retirement unless pinned or still held by an allocation.

### Ready workers

After a successful session activation, OpenClaw can prepare an unassigned worker in the background for the next matching session. Defaults are one worker per repository and profile, with a Gateway-wide cap of four. A ready worker is consumed once and then refilled. If none is ready, the session provisions normally, using a compatible snapshot when available. Paired devices do not use this pool.

An authorized Control UI browser also keeps the configured default repository's reserve target prepared. Read-only browsers do not allocate workers. After the last eligible browser disconnects, presence-driven refill stops and unused reserves retire after 15 minutes. Repository access and identity are checked again before reuse; changed visibility or lost access prevents reuse of earlier capacity.

Empty workspaces share a separate runtime-only reserve per provider and profile, containing no session files or credentials. The first empty session provisions normally; activation can refill its reserve. Browser presence alone does not warm empty workspaces.

Set `cloudWorkers.profiles.<id>.readyWorkers` for the per-project target and `cloudWorkers.preparedPool.maxTotal` for the shared cap. Zero drains unused reserves and disables the corresponding refill, preserving active sessions and snapshot reuse. Preparing workers and unconfirmed cleanup count toward both limits. Reserves require an eligible dedicated Linux profile with warm images and a known machine class.

Ready workers incur running-machine charges until deletion is confirmed. Demand expires using the provider's idle timeout; refill and Gateway restart do not extend it. Expired, incompatible, disabled, and surplus workers retire. Temporary provider or artifact-observation failures defer maintenance, retaining existing capacity and its expiry. Check the pool limits and Gateway's refill diagnostic if no reserve appears after activation.

**Build on demand:** `environments.prepare` accepts `{ profileId, projectPath }` with `operator.admin`, prepares a local Git checkout's committed `HEAD`, and authorizes its setup recipe. It returns `{ environmentId, preparationKey, reused }`, reusing matching work already in progress. It requires an eligible profile and room under the pool cap. A build can finish with `readyWorkers: 0`, then ordinary reserve policy may retire it as surplus. `environments.destroy` cancels an unused build or reserve and waits for provider work and cleanup to settle.

An already-admitted capture can finish after reserve-demand expiry within its secured source lifetime and provider budget, while its worker remains counted. Reserve-demand expiry does not grant more provider lifetime or allow later enrollment, readiness, or consumption; cleanup follows settled capture custody.

### Inspect snapshots in the Control UI

Open **Settings → Connections → Cloud environments**. Each repository has one row showing **Ready**, **Building**, **Cold only**, or **Needs attention**. Select it to inspect its snapshots, recorded setup source, step timings, and failures. **Machine → Change** sets the repository's default profile. Inventory refreshes while builds, captures, or ready workers are present, and after deferred plugin activation.

**Rebuild** prepares the recorded local project's committed `HEAD` without a session. It requires administrator access, a local project root, an eligible profile, and pool capacity. Repository-only sources cannot use this action. Rebuild follows normal refresh policy and may reuse a matching build or reserve; it does not force snapshot replacement. Active builds offer **Cancel**; failed builds offer **Dismiss**, which hides the row until reload while the terminal record remains retained. Orphaned builds still awaiting cleanup cannot be dismissed.

Snapshot overflow actions offer **Pin**, **Unpin**, **Delete**, and, when a previous generation exists, **Roll back**. Pinning protects an image from automatic retirement. Delete requires confirmation and is unavailable for pinned, held, or capturing images. Pin changes and rollback are unavailable during capture or retirement. Failed deletion remains pending and retries during maintenance.

Rollback restores the previous checkpoint as current. The demoted current image is retained when pinned or when `keepPrevious: 1`; otherwise it retires after allocations release it. A retained previous checkpoint can still be rolled back after lowering `keepPrevious` to `0`. If both generations are pinned, unpin one before publishing another replacement.

The collapsed **Advanced** section contains **Machines**, **Pool**, **Snapshot retention**, and **Machine images**. Machines manages profiles; Pool shows reserve counts and limits; Snapshot retention applies to all repositories. Machine images holds snapshots and builds without repository metadata, including uncertain captures. Saving machine settings refreshes eligibility without leaving the page.

Snapshot inspection and actions require `operator.admin` and the enabled Crabbox provider. Actions appear only when their methods are advertised. API clients use `crabbox.images.list` for local snapshot state and `includePreparedDetails: true` on `environments.list` or `environments.status` for pool details. Listing snapshots does not contact the provider or expose setup commands or secret values.

**Recover** appears only for uncertain captures. Its acknowledgement has the same meaning as the CLI's `--acknowledge-provider-cleanup`: follow the cleanup steps below first. Recovery clears the reservation; it does not stop a worker or delete provider artifacts.

### Recover a paused capture

Inspect local ownership without contacting the cloud:

```bash
openclaw crabbox warm-images --json
```

Status identifies the capture selector, source lease, checkpoint references, and recorded setup diagnostics without exposing setup commands or environment values. Doctor reports pending captures and retirements but does not clear them with `doctor --fix`. A capture older than 20 minutes can still be working; elapsed time alone is not a reason to recover it. Only an explicitly uncertain outcome requires recovery. If status asks for migration, follow [Upgrade warm-image state](/gateway/cloud-workers/warm-images#upgrade-warm-image-state) first.

A paused capture does not prevent source-lease cleanup, but enrollment on its uncertain source remains blocked until recovery clears the reservation.

Before recovery, stop the owning Gateway, any original capture processes, and the recovered worker. Use the source lease and capture time to reconcile the uncertain operation in Crabbox's checkpoint catalog, and resolve any untracked provider artifact. Only after those steps, copy the exact capture selector from status:

```bash
openclaw crabbox warm-images --recover <capture-selector> --acknowledge-provider-cleanup
```

The acknowledgement attests that the original capture and worker are stopped and untracked artifacts are resolved; elapsed time alone does not establish those facts. Recovery clears only that capture reservation, preserves known checkpoint references and allocation choices, and rejects a replaced selector. It does not stop processes, run provider commands, delete snapshots, or allocate a worker. Restart the Gateway afterward; the next eligible worker can capture again. Failed checkpoint retirements retry during periodic maintenance or that profile's later capture or warm-image-enabled worker teardown after provider deletion errors are resolved; they do not use capture recovery.

### Upgrade warm-image state

If warm-image status requests migration, stop the owning Gateway and original capture processes, then run:

```bash
openclaw doctor --fix
```

Doctor migrates state under the exclusive maintenance lock, preserving checkpoints, allocation choices, and cleanup obligations. Older empty capture markers become uncertain captures with their original recovery selector. Unsupported records remain unchanged with a warning; provisioning waits for required migration.

Older `warm-leases` rows record an enrolled class but cannot establish whether a lease originally started cold or from a checkpoint. These rows block new warm-image allocations until resolved. Doctor reports their count and exact recovery commands. Resolve each lease through its original Gateway or provider, stop its worker and owning processes, and reconcile provider artifacts before using the reported selector:

```bash
openclaw crabbox warm-images --recover <legacy-allocation-selector> --acknowledge-provider-cleanup
openclaw doctor --fix
```

This recovery deletes only the unchanged legacy row matching that selector. It does not establish provider absence or clean up a machine for you. Keep the row when cleanup is uncertain. Checkpoints already forgotten by older code are not rediscovered; reconcile those manually through Crabbox. Do not run older and newer writers against the same state or downgrade while allocations, captures, or retirements remain unresolved.
