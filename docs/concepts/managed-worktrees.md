---
summary: "Run agent tasks in isolated git checkouts with automatic snapshots and cleanup"
read_when:
  - You want an isolated branch and checkout for an agent task
  - You are configuring Workboard cards with worktree workspaces
  - You want to store managed worktrees on another disk or in a custom folder
  - You need to restore or clean up an OpenClaw-managed worktree
title: "Managed worktrees"
---

Managed worktrees give an agent task its own git branch and checkout without placing temporary directories inside the source repository. OpenClaw records them in the shared state database and snapshots their tracked and non-ignored untracked contents before removal.

## Sandboxed sessions

Sandboxed project sessions use a private source-only Git checkout for execution,
while the managed worktree remains the canonical owner of accepted changes.
Docker and Podman support this local projection. The host repository's shared Git
metadata and ignored-file provisioning are not mounted or copied into it.
See [Workspace access](/gateway/sandboxing/workspace-access#managed-project-workspaces)
for write policy, reconciliation, and conflict recovery.

The projection binding and pending reconciliation journal are additive SQLite
state. They do not change the database version. Before downgrading, let pending
workspace operations settle. Older versions do not reconcile these projections;
they leave their additive state and private files intact. Return to a supporting
version to recover pending changes rather than deleting a projection directory.

## Choose where worktrees are stored

By default, OpenClaw stores managed checkouts under `<openclaw-state-dir>/worktrees`. Set the global `worktreeRoot` option in `openclaw.json` to use another folder or disk:

```json5
{
  worktreeRoot: "/mnt/workspaces/openclaw-worktrees",
}
```

Use an absolute path on the Gateway host, `~` for the Gateway user's home directory, or a path beginning with `~/` for a folder inside it. Relative paths are rejected. The Gateway user must be able to create and write to the directory.

This setting applies to all managed worktrees, including session, manual, and Workboard worktrees; there is no per-agent override. It changes checkout storage only. The shared state database, snapshots of provisioned ignored files, allocation limits, and cleanup lifecycle remain associated with the same OpenClaw state directory.

Changing `worktreeRoot` affects new allocations. Existing registered worktrees keep their recorded paths for reuse and cleanup, and removed worktrees restore to their original paths. OpenClaw does not move existing checkouts or snapshots when this setting changes. Keep their original storage available until those worktrees are no longer needed.

Outside the default state-owned worktree directory, cleanup acts only on registered worktrees and acceleration templates. It leaves unrelated, unregistered folders in your custom location alone.

See [Configuration reference](/gateway/config-runtime#worktreeroot) for the option's default and scope.

## Filesystem acceleration

OpenClaw automatically uses filesystem acceleration for new managed worktrees when supported. Linux uses native Btrfs snapshots without requiring the `btrfs` command. macOS uses a native APFS directory clone, preserving independent file contents, executable modes, and symbolic links. Windows uses ReFS block clones, including on Dev Drive volumes. OpenClaw keeps the template on the same writable filesystem as the new checkout; the source repository can be on another filesystem. Git configurations with checkout filters, sparse checkout, per-worktree configuration, or external attributes use normal Git checkout.

To opt out, set:

```json5
{
  worktreeAcceleration: false,
}
```

Omitting the option or setting it to `true` enables automatic selection. Setting it to `false` uses normal Git checkout and file copying for new worktrees. Existing worktrees keep their contents and lifecycle. NTFS, ext4, HFS+, and other unsupported filesystems use the normal Git path. Unavailable native bindings or failed clones also fall back to Git; APFS and ReFS file-data cloning never silently substitute ordinary file copies inside the accelerated path.

APFS and Btrfs operations use isolated native helpers without changing the Gateway process's filesystem configuration. The Gateway and these helpers retain fs-safe's `auto` native default. An explicit `FS_SAFE_NATIVE_MODE=off` or `OPENCLAW_FS_SAFE_NATIVE_MODE=off` also disables these helpers. Read-only metadata workers can stop on cancellation; recovery waits for a write helper to exit before touching its destination.

On Windows, point `worktreeRoot` at a directory on a ReFS volume, such as `D:\worktrees`. ReFS provides file block cloning rather than a writable directory snapshot: OpenClaw creates the directory tree and clones each file's data. Full clusters can share storage; partial file tails and filesystem metadata still consume space. The Gateway needs ordinary file access, not administrator access, to clone worktrees on an existing volume.

OpenClaw maintains one reusable source-only template per repository and destination root. It rebuilds the template when the requested commit or checkout policy changes, and cleanup retires templates unused for seven days. Git continues to own worktree registration, indexes, and branches; the filesystem backend supplies the shared file contents.

If template cleanup cannot acquire its allocation lease or read its cache, OpenClaw logs a warning and continues ordinary worktree and snapshot cleanup. A later cleanup pass retries template retirement.

Templates contain checked-out source only. `.worktreeinclude` provisioning and `.openclaw/worktree-setup.sh` still run separately for each new worktree, under their existing permissions. Dependencies and setup output are not shared through the template. Copy-on-write snapshots share source storage until files change; their actual savings depend on the repository and subsequent writes.

The first accelerated worktree includes the cost of preparing a template through Git. Later APFS worktrees clone the whole directory in one native operation. OpenClaw reads shared data-stream identities in bounded native batches before updating Git's cached file metadata, avoiding a content reread for proven unchanged files. Git metadata preparation counts toward the timestamp-safety delay, so finishing it after the clone's timestamp boundary does not add another wait. Git still validates the resulting index and detects subsequent edits; unsupported index formats and unverified files receive ordinary Git validation.

Apple discourages general directory cloning through `clonefile` without publishing its complete rationale. One verified limitation is that directory clones do not apply the destination's inherited ACL permissions to descendants. OpenClaw uses normal Git checkout when the destination parent has inheritable ACL entries, when the template root carries ACLs, or when ACL inspection fails. It checks again around cloning to catch policy changes during preparation. Non-inheritable ACLs on the destination parent alone do not disable acceleration. Git owns permission inheritance; OpenClaw does not rewrite ACLs after cloning.

The fast path is limited to OpenClaw's private source-only templates; do not customize ACLs inside the template cache. Cancellation waits for an already-started native clone to finish before recovery can touch its destination.

ReFS cloning can take longer than native Git checkout for repositories with many small files because each file needs independent metadata and Git refreshes its index. Use `worktreeAcceleration: false` if checkout latency matters more than source storage savings.

## Repository source profiles

Full source remains the default. To select a repository-owned sparse source
profile when creating a **new** worktree:

```bash
openclaw worktrees create /path/to/repo --name gateway-task --source-profile gateway
openclaw worktrees create /path/to/repo --name combined-task --source-profile gateway --source-profile tooling
```

Track plain UTF-8 cone-directory lists in
`.openclaw/worktree-profiles/<name>`. Names use lowercase letters, digits and
hyphens (up to 64 characters, starting with a letter or digit). Each nonempty
line names a tracked repository-relative directory; do not use comments, globs,
absolute paths or parent traversal. Selected lists compose as a sorted union.
Git cone mode also retains files at the root and ancestor directories. OpenClaw
includes the definition directory so the selection remains inspectable.

Definitions are read from the immutable checkout commit, not uncommitted source
files. A default-remote retry loads the definitions again from its fallback
commit. Selection finishes before ignored-file provisioning and setup. It does
not request a dependency install or build, and an existing repository setup
script retains its independent policy. Profiles cannot reshrink reused or
restored worktrees; choose a new name.

The existing `--profile` option still selects runtime state; `--source-profile`
only selects repository source:

```bash
openclaw --profile work worktrees create /path/to/repo --name task --source-profile gateway
```

Expand intentionally before native work or whole-repository checks:

```bash
git -C /path/to/worktree sparse-checkout disable
```

If sparse materialization fails after registration, keep the partial checkout
and Git registration for recovery. A retry with the same name does not shrink
that partial state; inspect it before choosing a new worktree name.

Selected profiles currently use ordinary Git checkout. Git enables shared
per-worktree configuration when setting sparse rules, so subsequent full
checkouts of that repository also use Git fallback, including after a native
full expansion. Existing checkouts retain their own source and indexes.

Then run the separately requested dependency/build preparation. PR
whole-repository gates still require full source. Sparse checkout changes source
materialization, not shared Git objects or history; it is not shallow cloning.

## Layout and names

Each worktree lives at:

```text
<worktreeRoot>/<repo-fingerprint>/<name>
```

The repository fingerprint is the first 16 hexadecimal characters of a SHA-256 hash over the canonical git common directory and origin URL. A supplied name must match `[a-z0-9][a-z0-9-]{0,63}`. Without a name, OpenClaw generates a readable crustacean-themed name such as `brisk-lobster`. Inferred names already occupied by any registered worktree (including the caller's own removed checkout), local branch, or unmanaged path get a numeric suffix such as `brisk-lobster-2`; only a supplied name reuses or restores the caller's existing record.

OpenClaw creates branch `openclaw/<name>` at the requested base ref. Without a base ref, it fetches `origin`, uses the remote default branch when available, and falls back to local `HEAD` when the repository is offline or has no usable remote, including a stale `origin/HEAD` pointing to a deleted branch. An explicitly requested base must resolve to a commit; OpenClaw never substitutes another base for it. Git first registers the branch without materializing files, preserving its normal upstream-tracking rules. OpenClaw then captures that branch's commit and uses it for the size estimate, source template, and checkout. Later changes to the source ref cannot switch the files being written or reuse a smaller commit's allowance.

Git worktree registration and source materialization during creation or snapshot restore each have a five-minute timeout, including a creation retry from local `HEAD`. Fetching missing objects for the size estimate uses the same five-minute budget. Other managed-worktree Git commands keep their two-minute timeout, except admitted checkout deletion, which is joined to completion. The separate `.openclaw/worktree-setup.sh` step also keeps its own two-minute timeout.

## Capacity and disk space

OpenClaw uses 100 live managed worktrees per state directory as a cleanup target, not an admission cap. Count alone never blocks creation or snapshot restore; available disk space still bounds new allocations. Creation never evicts another session to make room. Manual and protected worktrees can keep the total above the cleanup target.

Before allocating a checkout, OpenClaw checks its destination, Git metadata, source checkout, and state volumes. It keeps 10% of each volume free, with a minimum reserve of 4 GiB and a maximum of 16 GiB, plus twice the estimated Git checkout and provisioned-file size. A validated reusable source template replaces the full Git checkout allowance with an estimate for clone metadata and Git index writes. Btrfs snapshots share directory metadata; APFS and ReFS clones budget metadata per tracked entry, with the ReFS volume allocation size included. Cold templates and every native Git fallback require the full checkout allowance again immediately before allocation. Provisioned files retain their separate full-copy allowance. An executable setup script requires additional room equal to the larger of 4 GiB or the current source checkout footprint excluding Git metadata. Space is checked again before provisioning/setup and after setup. An unavailable capacity reading stops allocation with an actionable error.

For partial clones, OpenClaw inventories missing objects before estimating checkout size and fetches them from the clone's promisor remote in one batch. The batch requests only the missing objects without treating shared commits as proof that their contents are available locally. The size inventory cannot trigger per-object lazy fetches. Partial clones are supported, but full clones are recommended for registry-owned projects to keep checkout and restore independent of missing remote objects. If objects are missing without a promisor remote, fetch or repair the clone before retrying. A Git timeout reports its budget and suggests checking remote reachability, repository locks, and partial-clone behavior.

Transient fetch failures, including an incomplete object transfer, retry once after one second within the original fetch timeout. Cancellation and expired workspace authority stop recovery; a second failure surfaces the Git error. See [Retry policy](/concepts/retry#managed-git-operations).

The Git worker reuses a bounded set of successful commit-size estimates while it remains active. Object availability and free disk space are checked on every allocation. Git replacement refs disable reuse of the affected size estimates, and worker shutdown discards them.

Creation, restore, removal, orphan cleanup, and snapshot expiry share one allocation lease across repositories and processes using the same state directory. This prevents cleanup from deleting an unfinished checkout or a snapshot being restored. Requests wait up to 10 minutes for that lease, allowing slow checkout or cleanup work to finish before reporting contention. Caller cancellation and overall request limits can stop the wait earlier. The separate Git and setup timeouts described above still apply. Costs on the same volume are added together. These checks are conservative estimates, not a disk quota: other OpenClaw state directories, shell commands, deployment tools, and arbitrary setup/build output can still consume space. Reusing an existing valid checkout does not allocate another checkout. Worktrees created directly through Git are outside the managed cleanup lifecycle.

Git inventories and directory-size calculations run on bounded background workers. Branch and checkout-context reads use a dedicated worker, separate from diff and snapshot processing. The Gateway keeps ownership of Git subprocesses, cancellation, allocation leases, and registry writes. Canceling an operation waits for its subprocesses and temporary-index cleanup to settle before releasing that ownership. A ref mutation still waiting behind another writer can cancel without waiting for that writer; mutations already running finish their cleanup before cancellation returns. Preparation is cancellable; once destructive checkout deletion starts, it finishes before cancellation returns so a partial checkout cannot replace the complete recovery snapshot on retry.

A snapshot reuses its operation's path inventories and pins the source HEAD while constructing its temporary index. Publication verifies HEAD atomically after waiting for other ref mutations. If HEAD changes during preparation, cleanup preserves the checkout and asks you to retry. Provisioned-file membership is checked again at capture time because ignore rules and the source index can change independently. Moving inventory work to a worker does not allow concurrent allocations or weaken snapshot protection.

Snapshot removal uses a smaller reserve of 128 MiB plus estimated snapshot writes, so safe cleanup remains possible below the operational reserve. If a snapshot cannot fit, removal preserves the checkout and asks you to free space first.

## Provision ignored files

Add `.worktreeinclude` at the source repository root to copy selected ignored, untracked files into a new worktree. The file uses gitignore-pattern syntax, one pattern per line, with `#` comments:

```gitignore
.env.local
fixtures/generated/**
```

Only files reported by git as both ignored and untracked are eligible. Tracked files are already present through git and are never copied by this step. OpenClaw does not overwrite or change destination files that already exist, does not follow symlinked directories, and preserves copied file modes. It records only paths it actually creates, so later manifest edits cannot make those files disappear from cleanup protection.

## Run repository setup

Git source materialization leaves submodules unpopulated, matching native worktree creation even when `submodule.recurse` is enabled. A repository setup script can initialize the submodules it needs.

If `.openclaw/worktree-setup.sh` exists in the source repository and is executable, OpenClaw runs it with the new worktree as its current directory. The script receives:

```text
OPENCLAW_SOURCE_TREE_PATH=<source checkout>
OPENCLAW_WORKTREE_PATH=<managed worktree>
```

A nonzero exit aborts creation and removes the new worktree and branch. This is a repository-local contract; there is no OpenClaw config key for it.

Setup failures report the exit code or termination signal, or an actual timeout after 120 seconds, with a bounded excerpt of recent output rather than the full setup log. If setup times out, inspect `.openclaw/worktree-setup.sh` and its dependencies for slow downloads, unavailable services, or commands waiting for interactive input.

## Session worktrees

For a fresh isolated session without a source repository, call `sessions.create` with `worktree: true` and `worktreeSource: "empty"`. This does not copy the agent workspace or any selected folder. It cannot be combined with `cwd`, project or repository selection, an external catalog, `execNode`, or `worktreeBaseRef`. The Control UI uses this mode for **New workspace** on paired devices and cloud destinations.

Each fresh session has its own OpenClaw-owned backing repository under `<openclaw-state-dir>/worktree-sources/empty`, so Git remotes and history remain isolated between sessions. The existing managed-worktree registry owns allocation, snapshots, restore, and cleanup; no database migration is needed. The backing source remains available while a live worktree or retained snapshot references it and is removed after its final expired snapshot is collected. Git is still required internally. Existing installations adopt this mode only for new explicit empty-workspace requests; existing sessions and their snapshots keep their original source.

If worktree preparation fails before the first model reply, the session records the failure reason. The Control UI shows it with the failed session and in the chat, and the transcript retains a failure notice. Command failures identify the command and its exit or timeout reason, so a Git setup timeout is distinguishable from a model-provider timeout.

Start an isolated chat from a Git-backed folder with a worktree session: on the Control UI's New session page, use the **Place** picker to choose a Gateway source folder, then select **Worktree** (with an optional base branch and worktree name). Choosing a paired device or cloud profile with a Gateway folder selected uses this managed-worktree path; remote placement never browses or binds an arbitrary node working directory. When the name is omitted, OpenClaw derives it from the explicit session label or the concise title generated from the first message, then falls back to a crustacean-themed name. iOS exposes the same choice from Chat actions, and Android exposes it beside New Chat, when the active agent workspace is Git-backed.

Remote sessions started from a Gateway folder retain a durable managed-worktree mirror for workspace reconciliation, recovery, and publication. The same disk-space checks apply to this mirror. To start without a Gateway checkout, select a GitHub repository and a remote destination instead: [repository cloud sessions](/gateway/cloud-workers#dispatching-a-session) fetch on the node and retain accepted checkpoints on the Gateway. Their checkpoints have a separate lifecycle from managed-worktree snapshots.

The Control UI offers **Worktree** only after confirming a usable Git checkout with at least one commit, or when a selected remote Git repository is awaiting cloning. Plain folders and newly initialized repositories without commits can run directly on the Gateway. A failed Git check also leaves direct execution available if the folder is accessible; a `.git` entry or saved project alone does not enable isolation. If you already selected **Worktree** and a later check fails, that selection stays visible and starting is blocked. Clear **Worktree** to run directly, or reselect the folder to check it again.

The base-ref field suggests up to 100 local and 100 remote refs, plus the default and current branches. The current branch comes from the selected checkout, including linked worktrees; a detached checkout has no current branch. Branch discovery reads that checkout directly without inventorying sibling worktrees. You can enter any branch or commit even when it is not suggested. If branch suggestions cannot be loaded, the Control UI explains that you can enter a ref manually; a verified Git checkout remains available for worktrees. The selected ref must still resolve to a commit before session creation.

Group **New session defaults** checks the agent workspace the same way as a custom folder. If verification fails, retry before saving the group defaults. A remembered cloud destination cannot block a new local draft in a plain folder; a transient Git-check failure leaves the saved destination intact for the next visit.

The Place picker's **Projects** section can start the same worktree flow from a registered project ID. The Gateway resolves the recorded checkout path, so this path remains available at [`operator.write`](/gateway/operator-scopes); selecting an arbitrary host folder still requires `operator.admin`.

Agents can also call `suggest_task` when they discover confirmed follow-up work outside the current task. The Control UI and Gateway-backed TUI offer **Start in a new session**. This starts the task directly in the suggested folder without creating a worktree or requiring Git. The new session is instructed to explain the need and ask the user before creating or switching to a worktree later. Dismissing a suggestion starts nothing. Suggestions and their IDs are ephemeral and do not survive a Gateway restart.

In the Control UI, the arrow beside **Start in a new session** offers two additional actions: **Start in a new worktree** creates an isolated session from the suggested Git checkout, and **Start in this session** sends the task to the current conversation. If the current session is running, the task follows its normal steering behavior. Worktree creation requires a usable Git checkout; a failed start displays an error and keeps the suggestion available to retry.

Closing a suggested-task card removes it immediately while the Control UI sends the dismissal to the Gateway. Other cards and the composer remain usable. If the request fails, the card returns with an error so you can retry; switching chats does not bring the old card into the new conversation.

The primary action and the Gateway-backed TUI send `taskSuggestions.accept` with `mode: "local"`. The Control UI menu sends explicit `worktree` or `session` modes for those choices. RPC clients also retain `cloud` mode. Omitted mode still means `worktree` for callers that used the original worktree action; the Control UI and TUI never omit it.

OpenClaw exposes these tools only to operator sessions with an actionable Gateway UI. Channel sessions and local/embedded TUI sessions do not receive them, because those surfaces have no portable typed task-action contract.

The resulting managed worktree is owned by the session, and every agent run in that session uses its checkout. When the workspace is a repository subdirectory, the worktree is anchored at the repository root and the session runs from the matching subdirectory inside it. Session worktree creation uses the method's `operator.write` scope. Repository checkout/ref hooks and filesystem monitors are always disabled. The `.openclaw/worktree-setup.sh` step runs only for an `operator.admin` caller; retries evaluate the current caller's scope rather than retaining the original caller's permission. `.worktreeinclude` provisioning still applies to every caller. Deleting the session attempts to snapshot and remove its managed worktree, including dirty worktrees and branches with unpushed commits. Hourly cleanup also snapshots session worktrees after 7 idle days, treating recent session activity as worktree activity. Removed worktrees remain restorable from their snapshots as described below.

Archiving a session commits its archive state, then snapshots and removes its managed checkout while preserving the conversation and worktree binding. A failed metadata write leaves the checkout untouched. If cleanup cannot finish safely, the session remains archived, its files stay preserved, and the error explains that cleanup is pending. Repeating archive retries cleanup; startup and hourly garbage collection also retry any checkout that remains. Automatic session archival uses the same metadata-first ordering.

Unarchiving, or an authorized human message that reopens the archived session, restores the original branch HEAD plus saved dirty and untracked files before admitting work. A restore failure leaves the session archived. If the original repository or its snapshot is missing, or the 30-day snapshot retention has expired, recover the original repository/snapshot or start a new task; OpenClaw does not substitute an empty checkout for the saved work.

`sessions.create` may include an absolute `cwd` to run directly in another Gateway folder or to choose the source checkout together with `worktree: true`. Connections with `operator.write` may use a Gateway `cwd` contained in any configured agent workspace; realpath containment prevents symlinks from escaping that boundary. Gateway paths outside those workspaces require `operator.admin`. Ordinary worktree chat creation remains `operator.write` and stays anchored to the configured workspace. For a Gateway source, New Session dispatches the completed worktree session to paired devices or cloud profiles instead of passing a paired-node working directory to creation. The separate `repository: { url, ref? }` create input starts a remote-owned repository session without a Gateway path or `worktree: true`.

`sessions.create` also accepts `worktreeBaseRef` and `worktreeName` alongside `worktree: true` to pick the base ref and the worktree name (the branch becomes `openclaw/<name>`); both stay at `operator.write`. If `worktreeName` is omitted, the session label or generated first-message title supplies the readable branch name, with a two-word, crustacean-themed fallback if naming fails or exceeds the 30-second wait. Raw first-message text is never a branch-name fallback. A title that arrives later updates the session without renaming its existing branch. For a new session with an initial message or task, creation returns the admitted session and run before worktree preparation finishes. The chat shows the submitted message and naming, checkout, and setup progress; failures remain visible and retryable in the same session. The agent starts only after the finalized worktree is bound. Creation without an initial turn still waits for preparation and returns the worktree in the create result. The bound checkout is persisted on the session row as `worktree: { id, branch, repoRoot }`, so session lists can show its checkout and branch. When session deletion cannot finish that cleanup, `worktreePreserved` identifies the active worktree record that needs attention and reports one bounded reason: owner mismatch, active use or competing cleanup, a foreign Git lock, snapshot failure, or another cleanup failure. These reasons describe cleanup and ownership, not whether the checkout is dirty or has unpushed commits.

An explicit session base must resolve to a commit. Local refs are checked before the session is saved; remote-project refs are checked after cloning. A missing remote ref is refreshed from the recorded project URL and retried only in a Gateway-managed clone, never an operator-registered checkout. Once accepted, the commit stays pinned across setup failures and retries while the original ref remains publication metadata. Invalid explicit refs never silently switch to the repository default. Managed-clone refresh uses an isolated Git repository for network transport, so checkout-local URL rewrites and hooks cannot redirect or execute during the fetch.

For a same-agent `sessions_spawn` with `worktree: true`, omitting `cwd` uses the parent's live managed repository or its directly selected registered project. The child gets its own managed worktree. An explicit source selection takes precedence; other spawns use the target agent workspace. A parent working directory alone does not authorize inheritance outside that workspace.

The parent session and its managed-worktree or registered-project binding must remain current until the child is accepted. Accepted child sessions retain their saved repository choice across parent archive, replacement, or worktree changes. A retry must still be authorized for the current child session and uses the current caller's setup permissions.

## Troubleshoot creation

If creation reports `git checkout has no commits`, create an initial commit in the source repository, then retry. Running `git init` alone does not provide a commit for the new worktree.

If **New session** reports `git worktree add failed`, read the termination reason and the final Git error lines. `Preparing worktree` and `Updating files` are progress, not the cause of failure. Error messages collapse carriage-return progress redraws and bound the diagnostic tail so it cannot flood the banner.

`timed out after 300 seconds` means a worktree checkout reached its five-minute limit. Other Git commands report `timed out after 120 seconds` at their two-minute limit. Check repository access and available disk space on the Gateway host. A signal or nonzero exit status alone does not establish a timeout; use any accompanying `fatal:` or `error:` detail to investigate. An output-limit error means the command exceeded its output capture limit.

Before another creation attempt, inspect `git -C <repo-root> worktree list` and `git -C <repo-root> branch --list 'openclaw/*'` for partial state. A failed creation does not guarantee that its checkout and branch were removed. Do not delete a checkout or branch without checking whether it contains work you need.

If a checkout's `.git` link points to missing administrative files, OpenClaw preserves its files and refuses to reuse it. Restore the original repository metadata before using `git worktree repair` from that repository. A different clone with the same remote URL does not recover the missing index or unpushed history; do not replace the link or rebuild the index without verifying the original metadata.

## Snapshots, cleanup, and restore

Removal first creates a synthetic commit containing tracked and non-ignored untracked files, then pins it at `refs/openclaw/snapshots/<id>`. Host-provisioned ignored files do not enter the Git snapshot or repository object database. OpenClaw stores only the ignored files it actually provisioned in chunked shared-state database rows; the recorded path set remains authoritative even if `.worktreeinclude` later changes or disappears. Restore reads those bytes from the immutable snapshot and reapplies their complete modes. Automatic cleanup preserves a live worktree when a recorded path can no longer be snapshotted safely. If snapshot creation fails, removal stops unless `--force` explicitly permits snapshot loss.

Sandbox-created ignored files (including symlinks) and empty directories already accepted by reconciliation remain in the existing projection owner’s custody. Before removal, OpenClaw retains their missing snapshot delta in its pending-result receipt and private recovery refs. Restore replays that receipt before another turn can synchronize the workspace. This does not force ignored paths into publication or import unrelated ignored host files. The receipt follows the same snapshot retention period, and unaccepted private edits defer cleanup. The legacy provisioned-file ledger remains regular-file-only. Older versions can restore that ledger and the Git snapshot, but do not apply the projection receipt; return to a supporting version to recover accepted guest data.

Ordinary removal is archival: after a successful snapshot it uses Git's forced checkout removal so dirty files can be restored later. The CLI's `--force` option permits snapshot loss; omitting it does **not** select non-force Git removal. Use `openclaw worktrees remove <id> --if-lossless` when deletion must be non-force. This uses the same owner as run-end cleanup, retains dirty or unpublished work, and never retries a Git refusal with force. It cannot be combined with `--force`.

Removal requires HEAD to remain on the recorded managed branch. Switching branches or detaching HEAD preserves the checkout and recorded branch. Branch deletion uses native `git branch -d` against the completed snapshot, so a tip advanced beyond that snapshot remains intact. Without a snapshot, the branch stays retained. Removal deletes only its own Git worktree registration and never runs repository-wide `git worktree prune`.

Nested Git repositories and linked worktrees are separate ownership boundaries. Automatic cleanup preserves the outer worktree even when a nested linked worktree shares its Git common directory. A nested OpenClaw-managed worktree is cleaned only through its own managed-worktree record.

OpenClaw applies these cleanup rules:

- At run end, it removes a worktree without Git force only when `git status --porcelain` is empty and `git log HEAD --not --remotes --oneline` finds no unpushed commits. It also checks the captured contents for edits hidden by index flags. Otherwise it retains the checkout and records why.
- Startup and hourly cleanup snapshot and remove unlocked Workboard- and session-owned worktrees idle for more than 7 days, even when dirty. Session worktrees whose owner is archived or absent are eligible immediately. Failed owner lookups preserve the checkout.
- Cleanup also removes the least recently active eligible run-owned worktrees above the default target of 100. Manual worktrees are never automatically removed, and protected worktrees can keep the total above the target until they are released or explicitly cleaned up.
- Snapshot records remain restorable for 30 days. Cleanup then deletes the snapshot ref and registry row.
- A live OpenClaw process lock and any foreign or unrecognized git worktree lock protect a worktree from garbage collection.

Each collection shares one preliminary lock inventory per repository across idle and limit checks. Removal rereads the current lock and verifies that the worktree's activity has not changed under its allocation lease before changing the checkout; preliminary inventories never authorize removal or stale-lock recovery. If cleanup cannot acquire the lease, it preserves orphan candidates and expired snapshots for a later pass.

Listing and cleanup mark a missing checkout as removed only if its recorded path, activity, and repository identity still match the earlier check. A restore or repository repair that completes during that check preserves the newer live record.

Run-end cleanup records its outcome on the worktree record: lossless removal, retention because the checkout is busy, dirty, unpushed, or has provisioned-file drift, or failure with an error reason. Inspect the recorded outcome with `openclaw worktrees list --json` or `worktrees.list`.

If checkout deletion fails or is interrupted, OpenClaw preserves the completed capture at `refs/openclaw/removals/<id>`. A later removal refuses to replace that capture with files from a possibly partial checkout. Preserve the remaining files, recorded branch, snapshot refs, and shared-state database for recovery. Inspect the original removal error and Git worktree registration before attempting cleanup; do not repeatedly force removal or prune registrations. A normal completed removal, successful restore, or snapshot expiry clears this recovery ref. A failure after checkout removal can leave its branch retained and require operator reconciliation before restore can recreate that branch.

For an interrupted **ordinary clean snapshot** removal, use the exact pending commit:

```bash
openclaw worktrees recover-removal <id> --snapshot <pending-commit> --json
```

Recovery keeps the original capture, verifies the retained index and all remaining
files, repairs only that checkout's missing Git link, and recreates only missing
captured files without overwriting existing paths. Native non-force Git removal
then completes the checkout and branch cleanup. This can temporarily require disk
space for the missing files. The snapshot remains available for restore; this
command does not retire snapshots or run repository-wide repair/prune.

Stop external editors, terminals, and other unmanaged writers before recovery.
Managed consumers stay excluded until finalization; a synchronous byte/mode check
admits native deletion without an intervening asynchronous check.

Changed files, foreign paths, live consumers, changed refs/registry ownership,
missing original metadata, and an index that differs from the capture stop recovery.
Dirty captures, provisioned ignored files, projected workspaces, and exact-state
retirements retain their existing recovery owners. Preserve those sources for
inspection; this command does not reinterpret them as clean removals. An interrupted
recovery can be repeated with the same ID and snapshot after its blocker is resolved.
Once checkout deletion is admitted, it is joined without the ordinary Git command
deadline so that the timeout cannot interrupt deletion again.

Restore recreates `openclaw/<name>` at the original pre-snapshot commit, reusing its clean source template when available. Git applies the saved differences as unstaged modifications and untracked files without replacing the template with snapshot contents. Without a reusable template, Git materializes the snapshot directly. Disk admission includes space for changed and added files alongside clone metadata, or the full snapshot for an ordinary checkout. If the snapshot changes `.gitattributes` or its diff exceeds the bounded inventory size, Git rematerializes all snapshot files with a full-copy space allowance. This applies the snapshot's line endings and filters even to unchanged blobs. The synthetic snapshot stays out of branch history; its ref remains recorded as provenance.

A branch at a shallow history boundary can still be snapshotted and restored. If a later depth-limited fetch makes the snapshot commit itself shallow, Git may no longer resolve its parent. Restore then preserves the snapshot and reports the repository and snapshot commit with `git fetch --unshallow` guidance. OpenClaw does not deepen automatically: origin may not contain the local snapshot, so even a successful fetch cannot guarantee recovery. If the snapshot remains shallow after fetching, recover its parent from the original repository before retrying.

## Retire an already removed snapshot early

Use `openclaw worktrees retire-snapshot` only when the removed snapshot is redundant
with a retained local branch or remote-tracking commit. This local CLI operation
requires the exact worktree ID, snapshot ref and commit, recorded `removedAt`
milliseconds, and retained source ref and commit. Read those identities from the
removed record and repository before invoking it:

```bash
openclaw worktrees retire-snapshot <id> \
  --expected-ref refs/openclaw/snapshots/<id> --expected-oid <snapshot-commit> \
  --removed-at <milliseconds> \
  --retained-ref refs/heads/<retained-branch> --retained-oid <source-commit> --json
```

Retirement applies only to ordinary snapshots, not exact-state recovery snapshots or
their retained checkouts. It requires identical source trees and retained snapshot-parent history.
It refuses a live or reappeared checkout, Git registration, changed identity,
pending removal, run/removal consumer, unknown or nonempty provisioned-file
inventory, or any retained local workspace projection. Git equality does not prove
that accepted ignored projection data is redundant. It uses the existing allocation
lease and projection owner, then atomically verifies the retained ref and deletes
only the expected snapshot ref. It does not create a backup, delete the retained
source or PR outcome refs, run global garbage collection, or report reclaimed disk
bytes. Git object storage can remain shared after ref retirement.

A successful JSON result is `{ "retired": true, "id": "<id>" }`; the removed
registry entry is then absent and cannot be restored. A refusal is not cleanup
success. If an interruption occurs after the ref is retired, inspect the remaining
record and projection custody before further cleanup; this command does not infer
safe retirement from a missing ref. This operation is CLI-only, not a Gateway or
Control UI action.

## Exact-state detached retirement

Ordinary removal, forced removal, and `--if-lossless` still refuse a detached
HEAD. To retire a deliberately detached managed checkout without changing its
recorded branch or staging state, use an explicit owner-fenced request:

```bash
openclaw worktrees remove <id> --exact-state /path/to/retirement.json --json
openclaw worktrees restore <id> --json
```

The request contains the current registry owner and lifecycle timestamps from
`worktrees list --json`, the detached `HEAD` commit, the recorded branch's commit,
and the SHA-256 of the original Git index bytes. For example:

```json
{
  "ownerKind": "session",
  "ownerId": "example-session",
  "createdAt": 1800000000000,
  "lastActiveAt": 1800000000001,
  "head": "1111111111111111111111111111111111111111",
  "branchHead": "2222222222222222222222222222222222222222",
  "indexSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Use actual observed values, not the example. Omit `ownerId` for a manual record
without an owner ID. This option cannot be combined with `--force` or
`--if-lossless`. A live run lease, foreign Git lock, changed owner/lifecycle, or
changed HEAD, branch, index, or captured files preserves the checkout. It does
not authorize removing another session's active work.

The versioned snapshot keeps the detached commit and separate recorded branch
tip, the original index bytes and split-index dependency, and objects referenced
only by staging, cache-tree, or resolve-undo state. It saves raw tracked and
non-ignored untracked bytes, symbolic links, permission mode bits, and modification
times. Ignored-file selection in this snapshot stays unchanged: only the native
provisioned-file ledger and staged-input contract preserve eligible ignored files.
Object-only recovery does not reproduce filesystem identities such as inode
numbers or change times. The recorded branch stays at its original commit.

**Exact retirement is archival, not immediate disk reclamation.** It moves the
original checkout through native Git to a private recovery name and removes the
live managed-worktree binding. The original checkout and its native registration
remain under the same 30-day recovery retention as the immutable snapshot. The
result includes `recoveryPath` and `recoveryRetainedUntil`. This retains writes
from processes that already held a working directory or open file descriptor;
Git index/ref locks alone cannot make deleting those bytes safe. The recovery
path is not an active workspace. Snapshot expiration deletes this retained
checkout, so do not continue working there or treat it as permanent storage.

Exact-state retirement requires a full, non-sparse checkout with Git file refs
and supported Git index extensions. It holds native Git index and ref locks while
revalidating its index, refs, files, and authority before archival finalization.
A validation failure moves the complete checkout back when its original path is
still available. Neither move overwrites a recreated source path.

Restore normally moves the retained original checkout back, preserving its index,
metadata, ignored caches, and even workfile writes made through old handles after
capture. If its HEAD or index changed, restore refuses and preserves both recovery
sources. If the retained checkout and its registration are both unavailable,
restore instead materializes the immutable snapshot directly from Git objects,
without filters, line-ending conversion, or working-tree encoding. That fallback
restores only the snapshot's eligible ignored files, not unrelated caches. Both
routes restore detached HEAD without replacing the recorded branch. If restore
is interrupted after its native move, retry restore: it recognizes only the
captured original directory incarnation at the live path and never adopts a
recreated replacement directory.

Object-only restoration also keeps a versioned native Git recovery receipt for
the newly allocated directory incarnation. It publishes complete files and the
original index atomically while native Git locks exclude staging and HEAD
writers through registry finalization. Retry the same restore command after an
interruption; it resumes only that receipt-owned directory and preserves changed
or replacement sources. Publishing the exact index is the restoration commit
point: a retry after that point preserves subsequent workfile edits and only
finishes registry cleanup. The receipt is cleared after successful finalization.
A retry after interrupted snapshot expiration can finish the expired registry
entry without guessing the identity of an unknown retained directory.

Snapshots use `refs/openclaw/snapshots/exact-v1/<id>` and the existing 30-day
retention owner. Keep repository objects, retained recovery checkout, and the
shared-state database together. Use a runtime supporting this option; older
restore implementations cannot preserve the extra index state. Ordinary
snapshots retain their existing behavior.

If the native archival move completes but registry finalization is interrupted,
reconcile and restore with the original request:

```bash
openclaw worktrees restore <id> --recover-exact-state /path/to/retirement.json --json
```

Recovery requires the matching completed capture and unchanged owner and recorded
branch. Recovery holds the existing removal claim while the registry still shows
a live row, rejecting active runs and new run admission until it settles. A retry
recognizes the captured original directory already moved back; it never adopts an
unknown occupied path. An inconsistent source/registration preserves all recovery
material and refuses to overwrite it. Listing and garbage collection
do not infer completed retirement from the missing original path. Preserve
unfinished source and recovery for inspection; do not force another removal,
reset the index, reattach HEAD, or prune the registration.

## CLI

```bash
openclaw worktrees list [--json]
openclaw worktrees create <repo-root> [--name <name>] [--base-ref <ref>] [--source-profile <name>]... [--json]
openclaw worktrees remove <id> [--force | --if-lossless | --exact-state <file>] [--json]
openclaw worktrees restore <id> [--recover-exact-state <file>] [--json]
openclaw worktrees gc [--json]
```

The Control UI **Worktrees** page under Settings provides the same actions plus creation with a base-branch picker, shows each worktree's owner (manual, Workboard, or the owning session with a link into its chat), and offers a force retry when a removal reports a failed snapshot.

Leave **Base branch** empty to fetch and use the remote default branch. Branch suggestions do not select a base; choosing or entering a branch or commit uses that exact ref without fetching. Clearing the field restores automatic selection. Fetching updates remote-tracking refs, not the source checkout's local `main`; the local-`HEAD` fallback described above still applies when the remote default is unavailable.

`--if-lossless --json` returns `removed` plus the recorded `cleanup` outcome. A retained checkout returns `removed: false`; it is not a successful deletion. The explicit `--if-lossless` option is CLI-only; Gateway removal retains its archival behavior and result format.

## Gateway methods

| Method               | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `worktrees.list`     | List active and restorable worktree records.                            |
| `worktrees.branches` | List local and remote branches of a repository for base-ref pickers.    |
| `worktrees.create`   | Create or reuse a named managed worktree.                               |
| `worktrees.remove`   | Snapshot and remove a worktree. Forced removals report `snapshotError`. |
| `worktrees.restore`  | Restore a removed worktree from its snapshot.                           |
| `worktrees.gc`       | Run idle, orphan, and retention cleanup now.                            |

`worktrees.list` requires `operator.read`. `worktrees.create` and `worktrees.branches` require `operator.write` for configured agent workspaces and registered projects; arbitrary host paths still require `operator.admin`. All creation disables repository Git hooks; write-scoped creation also skips `.openclaw/worktree-setup.sh`. Removing, restoring, and garbage-collecting worktrees remain admin-only. Branch listing reads existing refs only and never fetches, and remote-only branches come back remote-qualified (`origin/feature-a`) so every returned name resolves as a base ref. New Session can also request a typed repository status from this method; a plain directory or unavailable checkout returns no branches instead of forcing the UI to infer Git capability from an error string.

## Workboard workspaces

The bundled [Workboard plugin](/plugins/workboard) can materialize a card workspace as a managed worktree:

```json
{
  "kind": "worktree",
  "path": "/absolute/path/to/source-checkout",
  "branch": "main"
}
```

`path` identifies the source git checkout. `branch` is optional and becomes the base ref. For a full-host caller, Workboard creates or reuses `wb-<card-id>`, runs the subagent with the managed checkout as its working directory, and writes the resolved path and branch back to the card. Gateway clients need `operator.admin` for full-host materialization. On run end, Workboard removes the checkout only when it is provably lossless; dirty work or unpushed commits remain available.

For a workspace-bound caller, `path` and the repository root must exactly match the target agent workspace. Workboard then runs directly in that directory and records a directory workspace instead of host-materializing a managed worktree. The target must use a writable, non-shared Docker sandbox for the same workspace, its live container hash must match the requested mounts and policy, and it must not expose elevated execution, host control, host-wide sessions, persisted host/node execution, or unclassified plugin and MCP tools. If the target policy or live container is broader, dispatch leaves the card unclaimed and reports the incompatible state.

## Related

- [Workboard plugin](/plugins/workboard) — cards that materialize a managed worktree
- [Configuration reference](/gateway/config-runtime#worktreeroot) — where `worktreeRoot` is set
