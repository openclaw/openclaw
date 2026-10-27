---
summary: "The none, ro, and rw workspace access modes, the role-required cap, and skill mirroring"
title: "Workspace access"
read_when: "You are deciding what the sandbox can see of the agent workspace."
---

What `workspaceAccess` exposes to the sandbox, how a role-required sandbox caps it, and how skills are mirrored into the sandbox workspace.

## Workspace access

`agents.defaults.sandbox.workspaceAccess` controls what the sandbox can see:

| Value            | Behavior                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `none` (default) | Tools can read and write an isolated sandbox workspace under `~/.openclaw/sandboxes`; the agent workspace is not exposed. |
| `ro`             | Mounts the agent workspace read-only at `/agent` (disables `write`/`edit`/`apply_patch`).                                 |
| `rw`             | Mounts the agent workspace read/write at `/workspace`.                                                                    |

For a role-required sandbox, OpenClaw caps configured `rw` workspace access at
`ro` and logs an `agent/sandbox` warning. The guest keeps a separate sandbox
workspace, while the shared agent workspace is available only as a read-only
mount. This prevents guests from sharing the writable agent workspace; `none`
and `ro` remain unchanged. Sessions without a role-required sandbox retain their
configured workspace access.

The session Files browser follows this workspace boundary. With local Docker or
Podman and `workspaceAccess: "none"`, listings, searches, previews, and downloads
use the session's private sandbox workspace, including files created during
ordinary noncoding chats. An unavailable private workspace never falls back to
the shared agent workspace. Explicit `ro` access and managed project workspaces
retain their existing admitted source access. Viewing a shared session uses that
session's workspace; it does not switch to the viewer's own sandbox. Session
visibility alone does not let a sandbox-required reader browse an unsandboxed
shared host workspace. Ordinary nonsandbox-required read-only readers keep
their existing in-root access.

The Changes view requires an admitted project checkout. An unmanaged private
sandbox remains available in Files, but Changes returns the existing `not_git`
notice instead of running host Git against private sandbox metadata. Managed
project and admitted host checkouts retain their existing diff behavior.

## Managed project workspaces

A sandboxed session with a session-owned managed worktree uses a private Git
checkout on Docker and Podman. A registered project may be outside the agent's
configured workspace when it is selected with `worktree: true`. This authorizes
source preparation, not direct access to that host directory. Arbitrary external
`cwd` values and direct project bindings remain restricted.

Visible child sessions keep their managed worktree as the sandbox workspace on
later turns, including sessions created before an update.

The private checkout contains the selected source commit, not the host's shared
Git configuration, credential helpers, other branches, or ignored files selected
by `.worktreeinclude`. Guest preparation does not run the repository's host setup
script. Source-only checkout, snapshot, and restore operations use a
command-scoped trusted Git configuration view, so repository, worktree, global,
and included filter programs cannot execute on the Gateway—even if configuration
changes while preparation is waiting. Private-checkout packing uses that same
configuration boundary and does not lazily fetch missing Git objects. If the
source is incomplete, fetch its objects through the trusted host workflow and
retry preparation. Git still owns the registered worktree,
index, HEAD, and snapshot refs; ordinary trusted maintainer checkouts are unchanged.
The guest’s Git commands operate on private metadata. Initial non-ignored source
paths are admitted before guest execution and retained in the projection binding.
Later host-created paths enter an existing projection only after the host stages
them in the host Git index (`git add`); changing an ignore rule alone does
not admit host files, including newly provisioned files. Existing admitted source
edits and guest-created files continue to reconcile, including guest-created
ignored files. Source filenames must be valid UTF-8; rename invalid Git paths
before retrying preparation. Publication uses the same admission boundary.
Host recovery snapshots retain host data under their existing rules, but
restoration does not admit that data to the guest. Use the
session's managed GitHub publication action to publish accepted changes; host credentials are not
copied into the sandbox. The runtime-owned `.openclaw/sandbox-skills` subtree
is excluded from workspace reconciliation and publication, as is the scratch
directory described below. Other project content under `.openclaw` is retained.
Its empty mount targets are created by the host
workspace owner before container allocation, while the skill mounts remain
read-only. This also keeps normal retention cleanup independent of container
user-namespace ownership.

At the checkout root, `.cache/vitest/`, `.cache/bun-transpiler/`, `.cache/openclaw/bun/`,
`.cache/ms-playwright/`, and `.local/share/pnpm/store/` caches stay with the runtime
that produced them, along with `.artifacts/vitest-workers/` compiler outputs,
`.artifacts/vitest-worker-cache/` retained compiler outputs,
`.artifacts/vitest-shard-timings.json` scheduling samples, and
`.artifacts/dist-artifacts.lock/` ownership files. The root `.openclaw/tmp/`
scratch directory also stays local, including downloaded toolchains and browsers.
Scratch remains available to later commands in the same runtime, but is not
synchronized or restored onto another runtime. Save durable outputs outside it;
other `.openclaw/` content and nested project fixtures still reconcile.
Synchronization and recovery of older pending results exclude these exact paths,
so dependency and test-tool downloads do not count as authored workspace results.
Other guest-created files under `.cache/`, `.local/`, and `.artifacts/` still
reconcile, including nested paths and explicit staged inputs; an ignore
rule alone does not make a file disposable. Source changes cannot remove a
runtime-owned lock subtree by replacing its parent directory.

Changed user files remain limited to 64 MiB each. If one exceeds the limit, reduce
it or move it outside synchronization before retrying; repeated messages cannot
resolve the size violation. For a newly created local sandbox file,
[`openclaw sandbox recover`](/cli/sandbox#openclaw-sandbox-recover) preserves the
file outside synchronization so the next turn can settle the remaining edits.

Local managed guest workspaces also exclude disposable `.artifacts/build-all-cache/`
build snapshots and `.artifacts/build-cache-inputs/` temporary receipts. Original
inputs admitted from the host source or its Git index remain protected even within
those roots. Guest Git metadata cannot admit generated files as original inputs.
The same input custody applies during capture, synchronization and recovery without
changing saved manifest bytes. Older archives can lack the original index
membership of saved files. Exact cache-root paths in the owned archive remain
restored inputs; new generated paths under the same directories are still excluded.
An ambiguous older cache file may therefore remain preserved.

For Git-backed native-node and SSH workspaces, worker-side captures also exclude
new generated files under those two build-cache roots. Tracked files, ignored
files explicitly selected by `.worktreeinclude`, and exact inputs recorded in a
prior capture remain part of the workspace. Ordinary `.artifacts/` reports still
synchronize, and unreadable authored files still fail capture. Plain workspaces
keep their existing capture policy even when staging creates Git metadata.
Older remote manifests can contain cache files whose origin is unknown; those
exact paths remain preserved. This does not change the initial Gateway-source
snapshot policy or remove previously retained cache files.

If you are a guest, you can ask the agent:

> Bring this workspace up to date with the latest project changes, keeping my
> edits. Resolve any conflicts, rerun the relevant checks and Auto Review, and
> update the same PR. Do not merge it.

Use `github_publish` with `action: "refresh_base"` to explicitly integrate the
current selected repository base into this session's existing local managed
workspace. This action is offered only in sessions with a writable managed sandbox;
sessions running directly on the host merge the base with git in their workspace,
then publish. The Gateway fetches with its host identity and prepares any missing
file contents from the selected repository before offline merge and snapshot
operations, including the ancestor versions needed to merge diverged branches.
This also works when a partial clone already knows the base commit. A
content-fetch failure leaves saved work available for retry. Refresh preserves
saved guest files, ignored guest data, and empty directories. The operation returns the exact
`baseCommit`, changed paths, and conflicting paths; it does not publish or change
the GitHub pull request. It accepts no repository, URL, arbitrary ref, other
session, or pull-request selector.

Resolve any reported conflicts in the same workspace, then repeat `refresh_base`
with `conflictsResolved: true` and the returned `baseCommit`. This acknowledges
that exact pending integration, including a deliberate choice to keep an unchanged
binary file. Without acknowledgment, a retry keeps reporting conflicts. Remaining
text conflict markers block completion. On completion, the calling sandbox imports
only the selected base commit and source tree through bounded stdin, reusing
available objects from host-selected snapshots when possible, then stages its
current source. Guest HEAD, branches, and commit history remain unchanged.
The result includes `review: { mode: "local", base: "<commit>" }`. Run tests and
normal Auto Review with that exact target after refresh or conflict resolution,
then publish to update the same PR, preserving its current draft or open state.
Reviewing against the old guest HEAD would
also include upstream-only changes. The operation requires the prepared sandbox
of the current agent; a direct RPC cannot supply another runtime. Publication
refuses a pending integration and never silently merges new base changes into
reviewed files. A retry or restart settles the existing retained source result
through the workspace journal; host merge ancestry remains outside guest Git
metadata. Worktree removal is deferred while the host integration is pending;
finish refresh before retrying archive cleanup. Existing privileged PR actions
still require full operator write access.

Finish refresh and conflict resolution before downgrading. An interrupted transfer
retains a source result that earlier Gateways reject instead of applying as ordinary
workspace synchronization. Once both copies accept the transfer, that result is
cleaned and native merge state owns any remaining conflict resolution. Return to a
version supporting `refresh_base` to finish either pending phase.

The private checkout is writable with `none` or `rw` workspace access; explicit
`ro` remains read-only. This does not make the shared agent workspace writable.
Other sandbox backends cannot use this local managed-project projection and
fail with an explanation rather than falling back to host execution.

The managed worktree remains the source of truth for files, snapshots, and
publication. OpenClaw pauses the exact execution and browser runtimes that mount
this checkout while capturing or applying changes, records pending results and
rollback journals in SQLite, and resumes
only after settlement. New shell calls and command preparation wait for an active
checkpoint to release the workspace before proceeding; background commands do not
hold that preparation lease for their entire lifetime. Captured workspace authority is checked again after
filesystem and engine preparation, immediately before filesystem commands,
container creation/start/setup, and late browser restarts. Closing the owner
during preparation prevents those effects rather than rejecting only afterward.
Stopping a run blocks new commands and file operations while allowing its accepted
workspace changes to finish checkpointing. Accepted command cleanup waits for an active checkpoint to resume the runtime
before reaping its processes. Its reap budget starts after admission; the command's
original exit and timeout results remain unchanged. Termination checkpoints any
final writes from signal handlers before returning, including when an earlier
finalization already checkpointed the command. Cleanup retains the workspace owner
until termination and finalization finish, even after the parent exits.
Settlement still requires the original
session and worktree binding and live Gateway ownership; a replacement session or
unresolved checkpoint failure cannot be reported as a clean stop.
Conflicts preserve both versions and block further
settlement until resolved. A retry or restart recovers the same pending result.
Archive, reset, and deletion settle changes before retiring their runtimes;
successful retirement clears owned pause receipts without resuming those runtimes.
Failed retirement preserves guarded recovery for surviving paused runtimes.
Projection cleanup follows the existing managed-worktree snapshot retention.
Accepted guest-created ignored files (including symlinks) and empty directories
survive archive and restore through the same pending-result recovery owner. This
does not force ignored paths into Git publication or import unrelated ignored host
files. Older versions leave that recovery receipt intact but do not apply it;
return to a supporting version before continuing guest work.

With the OpenShell backend, `mirror` mode still uses the local workspace as the source of truth between exec turns, and `remote` mode uses the remote OpenShell workspace as the source of truth after the initial seed. The same access rules apply: `none` permits private workspace writes, while `ro` disables writes.

Inbound media is copied into the active sandbox workspace (`media/inbound/*`).
Later conversation turns load retained images from that same staged copy.
Missing copies and paths outside the active sandbox remain unavailable.
For a managed project session, attachments on follow-up messages use that
session's private checkout, including after its worktree has been created.
Attachment staging retains the managed workspace owner until the copy settles.
If the worktree is removed while an attachment is being read, staging stops
before creating its input directory or file; the original attachment remains available.

`image_generate`, `video_generate`, and `music_generate` also copy locally saved
outputs into a private, Git-ignored directory under `media/inbound/` in the
requesting sandbox. The tool result and asynchronous completion report a
`Sandbox file` path for follow-up reads, edits, and shell processing. Channel
delivery still uses the managed original. Each copy is limited to the smaller
of the configured media size limit and 50 MiB. Remote-only video URLs are not
downloaded for staging. If the workspace is read-only or staging fails, the
result reports that the sandbox copy is unavailable; generation and delivery
still succeed. Resetting or deleting the requesting session stops further sandbox
copies and prevents completion delivery to a replacement session. If a configuration
reload changes sandbox policy, workspace selection, or the media size limit before
a copy, staging stops with the same warning while the original remains available.

<Note>
**Skills**: the `read` tool is sandbox-rooted. With `workspaceAccess: "none"`, OpenClaw mirrors eligible skills into the sandbox workspace (`.../skills`) as read-only instruction roots; other private workspace files remain writable. With `"rw"`, workspace skills are readable from `/workspace/skills`, and eligible managed, bundled, or plugin skills are materialized into the generated read-only path `/workspace/.openclaw/sandbox-skills/skills`.

Local container mounts and sandbox file tools enforce these read-only roots.
Generated skill copies carry their own Git ignore rule, so ordinary Git discovery
omits them while tracked changes and other project files remain visible.
The Gateway refreshes its own mirrored copies even when an earlier copy inherited
read-only directory permissions; no manual permission repair is needed.
Unchanged skill snapshots reuse their mirrored copies. When supporting files
change, the Gateway reconciles regular skill trees incrementally: changed files
are replaced, removed files are pruned, and unchanged copies are retained.
SSH and OpenShell shell execution relies on the remote host or OpenShell policy
for filesystem restrictions; `workspaceAccess` alone does not make remote shell
paths read-only.
</Note>
