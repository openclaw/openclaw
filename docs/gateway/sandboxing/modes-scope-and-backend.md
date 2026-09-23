---
summary: "The three settings that control when sandboxing applies and how many environments are created"
title: "Modes, scope, and backend"
read_when: "You are deciding which sessions run sandboxed and how they share environments."
---

The mode, scope, and backend settings, how a creator-role requirement overrides agent mode, and what the runtime identity includes.

## Modes, scope, and backend

Three independent settings control sandbox behavior:

| Setting | Key                               | Values                                            | Default  |
| ------- | --------------------------------- | ------------------------------------------------- | -------- |
| Mode    | `agents.defaults.sandbox.mode`    | `off`, `non-main`, `all`                          | `off`    |
| Scope   | `agents.defaults.sandbox.scope`   | `agent`, `session`, `shared`                      | `agent`  |
| Backend | `agents.defaults.sandbox.backend` | `docker`, `podman`, `ssh`, `openshell`, `crabbox` | `docker` |

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

### Per-chat sandbox opt-out

An administrator can opt one idle chat out of configured sandboxing without
changing the agent or global configuration. `sessions.patch` accepts
`sandboxMode: "off"`; `sandboxMode: null` clears that choice and restores the
configured policy. Both mutations require `operator.admin` and existing access
to the target session. A creator-role requirement (`sandbox: "required"`) is
immutable and always takes precedence: even an administrator cannot opt that
session out.

For race-safe updates, include `expectedSessionId`, `expectedLifecycleRevision`,
and `expectedSandboxMode` (`null` means no override). A stale expectation rejects
the mutation rather than changing a replaced chat or overwriting another choice.
`sessions.patchMany` supports the same sandbox mutation with expectations on each
target. Stop any active run before changing the sandbox mode; the Gateway checks
again before committing and never changes containment underneath a running turn.

The choice persists with that chat across restarts and resets. A newly forked chat
does not inherit the opt-out; restoring a checkpoint in the same chat retains it.
Clearing the override does not remove sandbox containers or change other chats.
Older versions that do not support this preference follow their configured
sandbox policy instead.

Native runtime selection and sending can offer **Continue for this chat** when an
administrator explicitly chooses the native agent's own permissions. This
combines the optional sandbox opt-out with Full access and consent bound to that
chat and runtime. Optional native tool and workspace restrictions are then
delegated to the native agent; OpenClaw-hosted tools keep their existing policy.
After a refused send, confirmation saves the permissions and retries that message
once. Selection-only confirmation does not send the draft. Neither changes global
settings. Native consent is cleared on reset or runtime change and is never
inherited by a fork. Required sandboxing, required workspace boundaries, and remote
execution placement remain independently enforced. See
[native runtime permissions](/tools/acp-agents-setup#permissions-for-native-chat-runtimes).

### Scope and backend

**Scope** controls how many containers/environments are created:

- `agent`: one container per agent.
- `session`: one container per session.
- `shared`: one container shared by all sandboxed sessions (per-agent `docker`/`ssh`/`browser` overrides are ignored under this scope).

Required sandboxes with proven Gateway-profile creators use that profile as
their isolation boundary. Different guests on the same agent receive separate
environments and workspaces, regardless of configured scope. Sessions created
by the same profile reuse its existing environment and workspace, including
when the configured scope is `session`; this reuse does not rekey those paths.
Channel, unknown, and other non-profile creators instead receive a separate
required sandbox per canonical session. A matching raw ID cannot reuse a
profile's resources. Required sandboxing and the read-only workspace cap remain
in force; backend failure never falls back to host execution.
Sessions without a role-required sandbox keep the configured scope behavior.

When original Guest access is revoked, registered background commands retain that
access dependency and are cancelled even after their foreground turn finishes.
Closing the browser or stopping one turn does not revoke this retained access.

OpenClaw also stops and verifies a Docker or Podman container when it created
that container under the original access and every use has remained with the
same original invitation and profile. Multiple connections and sessions can
share that private container. Revoking one device or source preserves it while
another source remains authorized; revoking the invitation ends all of them.
This preserves saved workspace files and the
container's writable layer; stopping loses temporary filesystem and process
state. Ordinary authorized use can restart the retained container.

A different invitation, staff access, or unclassified use makes
that container ineligible for this shutdown. Explicitly shared containers,
containers already present when the Gateway starts, sandbox browsers, and other
backends also remain running. Their existing cancellation owners target the
affected work. Arbitrary detached processes inside these shared or unclassified
environments are not guaranteed to stop when access is revoked.

The [creator namespace migration](/reference/database-schemas#creator-namespace-migration)
does not delete or adopt old ambiguous workspaces or containers. Such sessions
start with separate resources after upgrade. Preserve any needed old data
before normal sandbox retention or manual cleanup, then recover selected files
explicitly as an operator; do not copy an entire ambiguous environment into a
trusted profile workspace automatically.

Non-shared runtime identity also includes the resolved agent workspace path. This prevents co-hosted workspaces that reuse the same agent or session keys from sharing Docker, browser, SSH, OpenShell, or plugin-provided sandbox state. `shared` scope intentionally remains workspace-independent.

The first use after upgrading from an older release creates non-shared runtimes and sandbox workspaces under the workspace-qualified identity. Existing non-shared runtimes are not adopted; this is an intentional one-time reset. They can age out through configured prune settings or be removed with `openclaw sandbox recreate`; the next use provisions the current identity.

**Backend** controls which runtime executes sandboxed tools. Docker and Podman share `agents.defaults.sandbox.docker`; SSH-specific config lives under `agents.defaults.sandbox.ssh`; OpenShell-specific config lives under `plugins.entries.openshell.config`; Crabbox lease settings live under `plugins.entries.crabbox.config.sandbox` (see [Crabbox backend](/gateway/sandboxing/crabbox-backend)).

|                     | Docker or Podman backend                  | SSH                            | OpenShell                                           |
| ------------------- | ----------------------------------------- | ------------------------------ | --------------------------------------------------- |
| **Where it runs**   | Local Docker or Podman container          | Any SSH-accessible host        | OpenShell managed sandbox                           |
| **Setup**           | Docker and/or Podman                      | SSH key + target host          | OpenShell plugin enabled                            |
| **Workspace model** | Bind-mount or copy                        | Remote-canonical (seed once)   | `mirror` or `remote`                                |
| **Network control** | `docker.network` (default: none)          | Depends on remote host         | Depends on OpenShell                                |
| **Browser sandbox** | Docker engine only                        | Not supported                  | Not supported yet                                   |
| **Bind mounts**     | `docker.binds`                            | N/A                            | N/A                                                 |
| **Best for**        | Local development and container isolation | Offloading to a remote machine | Managed remote sandboxes with optional two-way sync |
