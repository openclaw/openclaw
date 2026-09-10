---
summary: "Docker bind mounts for extra host folders, their access modes, and the bind security rules"
title: "Multiple folders for one agent"
read_when: "One sandboxed agent needs more than its primary workspace."
---

Giving a sandboxed agent extra host folders through bind mounts, how bind modes relate to workspace access, and the sources OpenClaw blocks by default.

## Multiple folders for one agent

Use Docker bind mounts when one sandboxed agent needs more than its primary workspace. Each entry maps a host folder to a container path with an explicit access mode:

```text
host-directory:container-directory:ro
host-directory:container-directory:rw
```

- `ro` makes the mounted folder read-only inside the sandbox.
- `rw` lets sandboxed tools and processes change the host folder.
- The container path is the path the agent uses. Host paths are not exposed automatically.

This example gives the `research` agent a writable primary workspace, read-only reference material at `/reference`, and a separate writable output folder at `/drafts`:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        scope: "agent",
      },
    },
    entries: {
      research: {
        default: true,
        workspace: "/srv/openclaw/research-workspace",
        sandbox: {
          workspaceAccess: "rw",
          docker: {
            binds: ["/srv/shared/reference:/reference:ro", "/srv/shared/drafts:/drafts:rw"],
            // Required because these sources are outside the agent workspace.
            dangerouslyAllowExternalBindSources: true,
          },
        },
      },
    },
  },
}
```

`workspaceAccess` and bind modes are independent:

| Setting                          | Controls                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `workspaceAccess: "none"`        | Uses a writable isolated sandbox workspace; does not expose the agent workspace. |
| `workspaceAccess: "ro"`          | Mounts the agent workspace read-only at `/agent`.                                |
| `workspaceAccess: "rw"`          | Mounts the agent workspace read/write at `/workspace`.                           |
| `docker.binds` entry `:ro`/`:rw` | Controls only that additional host folder at its configured container path.      |

Changing `workspaceAccess` does not change an additional bind from `ro` to `rw`, or vice versa. Global and per-agent `docker.binds` are merged. Keep `scope: "agent"` or `"session"` for per-agent binds; `scope: "shared"` ignores all per-agent Docker overrides and uses only global binds.

Bind mounts are the supported multi-folder boundary because Docker constructs the container's filesystem view with mount isolation, and the `ro`/`rw` mode applies to every process in the sandbox. That boundary covers `exec`, filesystem tools, child processes, and libraries without duplicating path-authorization checks across each OpenClaw code path. A host-side path allowlist cannot provide the same complete boundary when an allowed shell or dependency can access files directly.

The opt-in `dangerouslyAllowExternalBindSources` only permits sources outside the workspace roots. It does not disable OpenClaw's blocked system, credential, Docker socket, symlink-parent, or reserved-target checks. Prefer the smallest folder, use `ro` unless writes are required, and recreate the sandbox after changing mounts:

```bash
openclaw sandbox recreate --agent research
```

### Other bind behavior

`agents.defaults.sandbox.docker.binds` configures global mounts. The format is the same `host:container:mode` form (for example, `"/home/user/source:/source:rw"`).

`agents.defaults.sandbox.browser.binds` mounts additional host directories into the **sandbox browser** container only. When set (including `[]`), it replaces `docker.binds` for the browser container; when omitted, the browser container falls back to `docker.binds`.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/data/myapp:/data:ro"],
        },
      },
    },
    entries: {
      build: {
        default: true,
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    },
  },
}
```

<Warning>
**Bind security**

- Binds bypass the sandbox filesystem: they expose host paths with whatever mode you set (`:ro` or `:rw`).
- OpenClaw blocks dangerous bind sources by default: system paths (`/etc`, `/proc`, `/sys`, `/dev`, `/root`, `/boot`), Docker socket directories (`/run`, `/var/run`, and their `docker.sock` variants), and common home-directory credential roots (`~/.aws`, `~/.cargo`, `~/.config`, `~/.docker`, `~/.gnupg`, `~/.netrc`, `~/.npm`, `~/.ssh`).
- Validation normalizes the source path, then resolves it again through the deepest existing ancestor before re-checking blocked paths and allowed roots, so symlink-parent escapes fail closed even when the final leaf doesn't exist yet (e.g. `/workspace/run-link/new-file` still resolves as `/var/run/...` if `run-link` points there).
- Bind targets that shadow the reserved container mount points (`/workspace`, `/agent`) are also blocked by default; override with `agents.defaults.sandbox.docker.dangerouslyAllowReservedContainerTargets: true`.
- Bind sources outside the workspace/agent-workspace allowlisted roots are blocked by default; override with `agents.defaults.sandbox.docker.dangerouslyAllowExternalBindSources: true`. Allowed roots are canonicalized the same way, so a path that only looks inside the allowlist before symlink resolution is still rejected as outside allowed roots.
- Sensitive mounts (secrets, SSH keys, service credentials) should be `:ro` unless absolutely required.
- Combine with `workspaceAccess: "ro"` if you only need read access to the workspace; bind modes stay independent.
- See [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for how binds interact with tool policy and elevated exec.

</Warning>
