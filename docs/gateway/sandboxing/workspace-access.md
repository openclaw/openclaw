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

With the OpenShell backend, `mirror` mode still uses the local workspace as the canonical source between exec turns, and `remote` mode uses the remote OpenShell workspace as canonical after the initial seed. The same access rules apply: `none` permits private workspace writes, while `ro` disables writes.

Inbound media is copied into the active sandbox workspace (`media/inbound/*`).

<Note>
**Skills**: the `read` tool is sandbox-rooted. With `workspaceAccess: "none"`, OpenClaw mirrors eligible skills into the sandbox workspace (`.../skills`) as read-only instruction roots; other private workspace files remain writable. With `"rw"`, workspace skills are readable from `/workspace/skills`, and eligible managed, bundled, or plugin skills are materialized into the generated read-only path `/workspace/.openclaw/sandbox-skills/skills`.

Local container mounts and sandbox file tools enforce these read-only roots.
SSH and OpenShell shell execution relies on the remote host or OpenShell policy
for filesystem restrictions; `workspaceAccess` alone does not make remote shell
paths read-only.
</Note>
