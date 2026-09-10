---
summary: "The three settings that control when sandboxing applies and how many environments are created"
title: "Modes, scope, and backend"
read_when: "You are deciding which sessions run sandboxed and how they share environments."
---

The mode, scope, and backend settings, how a creator-role requirement overrides agent mode, and what the runtime identity includes.

## Modes, scope, and backend

Three independent settings control sandbox behavior:

| Setting | Key                               | Values                                 | Default  |
| ------- | --------------------------------- | -------------------------------------- | -------- |
| Mode    | `agents.defaults.sandbox.mode`    | `off`, `non-main`, `all`               | `off`    |
| Scope   | `agents.defaults.sandbox.scope`   | `agent`, `session`, `shared`           | `agent`  |
| Backend | `agents.defaults.sandbox.backend` | `docker`, `podman`, `ssh`, `openshell` | `docker` |

**Mode** controls when sandboxing applies:

- `off`: no agent-wide sandboxing; sessions whose creator role requires a sandbox still run sandboxed.
- `non-main`: sandbox every session except the agent's main session. The main session key is always `agent:<agentId>:main` (or `global` when `session.scope` is `"global"`); it is not configurable. Group/channel sessions use their own keys, so they always count as non-main and get sandboxed.
- `all`: every session runs in a sandbox.

Set a named operator role's `sandbox` policy to `"required"` to sandbox that
role's newly created sessions regardless of agent mode. The creator requirement
is immutable for the session; unavailable backends fail closed, and elevated
execution or Gateway/node host overrides cannot bypass it. The default
`"inherit"` preserves existing agent-mode behavior. See
[Named operator roles](/gateway/operator-scopes#named-operator-roles).

**Scope** controls how many containers/environments are created:

- `agent`: one container per agent.
- `session`: one container per session.
- `shared`: one container shared by all sandboxed sessions (per-agent `docker`/`ssh`/`browser` overrides are ignored under this scope).

Required sandboxes with proven Gateway-profile creators use that profile as
their isolation boundary. Different guests on the same agent receive separate
environments and workspaces, regardless of configured scope. Sessions created
by the same profile reuse its existing environment and workspace, including
when the configured scope is `session`; this upgrade does not rekey those paths.
Channel, unknown, and other non-profile creators instead receive a separate
required sandbox per canonical session. A matching raw ID cannot reuse a
profile's resources. Required sandboxing and the read-only workspace cap remain
in force; backend failure never falls back to host execution.
Sessions without a role-required sandbox keep the configured scope behavior.

The [creator namespace migration](/reference/database-schemas#creator-namespace-migration)
does not delete or adopt old ambiguous workspaces or containers. Such sessions
start with separate resources after upgrade. Preserve any needed old data
before normal sandbox retention or manual cleanup, then recover selected files
explicitly as an operator; do not copy an entire ambiguous environment into a
trusted profile workspace automatically.

Non-shared runtime identity also includes the resolved agent workspace path. This prevents co-hosted workspaces that reuse the same agent or session keys from sharing Docker, browser, SSH, OpenShell, or plugin-provided sandbox state. `shared` scope intentionally remains workspace-independent.

The first use after upgrading from an older release creates non-shared runtimes and sandbox workspaces under the workspace-qualified identity. Existing non-shared runtimes are not adopted; this is an intentional one-time reset. They can age out through configured prune settings or be removed with `openclaw sandbox recreate`; the next use provisions the current identity.

**Backend** controls which runtime executes sandboxed tools. Docker and Podman share `agents.defaults.sandbox.docker`; SSH-specific config lives under `agents.defaults.sandbox.ssh`; OpenShell-specific config lives under `plugins.entries.openshell.config`.

|                     | Docker or Podman backend                  | SSH                            | OpenShell                                           |
| ------------------- | ----------------------------------------- | ------------------------------ | --------------------------------------------------- |
| **Where it runs**   | Local Docker or Podman container          | Any SSH-accessible host        | OpenShell managed sandbox                           |
| **Setup**           | Docker and/or Podman                      | SSH key + target host          | OpenShell plugin enabled                            |
| **Workspace model** | Bind-mount or copy                        | Remote-canonical (seed once)   | `mirror` or `remote`                                |
| **Network control** | `docker.network` (default: none)          | Depends on remote host         | Depends on OpenShell                                |
| **Browser sandbox** | Docker engine only                        | Not supported                  | Not supported yet                                   |
| **Bind mounts**     | `docker.binds`                            | N/A                            | N/A                                                 |
| **Best for**        | Local development and container isolation | Offloading to a remote machine | Managed remote sandboxes with optional two-way sync |
