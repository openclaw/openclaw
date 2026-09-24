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

## Managed project workspaces

A sandboxed session with a session-owned managed worktree uses a private Git
checkout on Docker and Podman. A registered project may be outside the agent's
configured workspace when it is selected with `worktree: true`. This authorizes
source preparation, not direct access to that host directory. Arbitrary external
`cwd` values and direct project bindings remain restricted.

The private checkout contains the selected source commit, not the host's shared
Git configuration, credential helpers, other branches, or ignored files selected
by `.worktreeinclude`. Guest preparation does not run the repository's host setup
script. Canonical source-only checkout, snapshot, and restore operations use a
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
them in the canonical Git index (`git add`); changing an ignore rule alone does
not admit host files, including newly provisioned files. Existing admitted source
edits and guest-created files continue to reconcile, including guest-created
ignored files. Source filenames must be valid UTF-8; rename invalid Git paths
before retrying preparation. Publication uses the same admission boundary.
Canonical recovery snapshots retain host data under their existing rules, but
restoration does not admit that data to the guest. Use the
session's managed GitHub publication action to publish accepted changes; host credentials are not
copied into the sandbox. The runtime-owned `.openclaw/sandbox-skills` subtree
is excluded from workspace reconciliation and publication; other project content
under `.openclaw` is retained. Its empty mount targets are created by the host
workspace owner before container allocation, while the skill mounts remain
read-only. This also keeps normal retention cleanup independent of container
user-namespace ownership.

The private checkout is writable with `none` or `rw` workspace access; explicit
`ro` remains read-only. This does not make the shared agent workspace writable.
Other sandbox backends cannot use this local managed-project projection and
fail with an explanation rather than falling back to host execution.

The managed worktree remains the canonical workspace for files, snapshots, and
publication. OpenClaw pauses the exact execution and browser runtimes that mount
this checkout while capturing or applying changes, records pending results and
rollback journals in SQLite, and resumes
only after settlement. Captured workspace authority is checked again after
filesystem and engine preparation, immediately before filesystem commands,
container creation/start/setup, and late browser restarts. Closing the owner
during preparation prevents those effects rather than rejecting only afterward.
Conflicts preserve both versions and block further
settlement until resolved. A retry or restart recovers the same pending result.
Archive, reset, and deletion settle changes before retiring their runtimes;
projection cleanup follows the existing managed-worktree snapshot retention.
Accepted guest-created ignored files (including symlinks) and empty directories
survive archive and restore through the same pending-result recovery owner. This
does not force ignored paths into Git publication or import unrelated ignored host
files. Older versions leave that recovery receipt intact but do not apply it;
return to a supporting version before continuing guest work.

With the OpenShell backend, `mirror` mode still uses the local workspace as the canonical source between exec turns, and `remote` mode uses the remote OpenShell workspace as canonical after the initial seed. The same access rules apply: `none` permits private workspace writes, while `ro` disables writes.

Inbound media is copied into the active sandbox workspace (`media/inbound/*`).

<Note>
**Skills**: the `read` tool is sandbox-rooted. With `workspaceAccess: "none"`, OpenClaw mirrors eligible skills into the sandbox workspace (`.../skills`) as read-only instruction roots; other private workspace files remain writable. With `"rw"`, workspace skills are readable from `/workspace/skills`, and eligible managed, bundled, or plugin skills are materialized into the generated read-only path `/workspace/.openclaw/sandbox-skills/skills`.

Local container mounts and sandbox file tools enforce these read-only roots.
SSH and OpenShell shell execution relies on the remote host or OpenShell policy
for filesystem restrictions; `workspaceAccess` alone does not make remote shell
paths read-only.
</Note>
