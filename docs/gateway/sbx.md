---
summary: "Use Docker Sandboxes (sbx) as a sandbox backend for OpenClaw agents"
title: Docker Sandboxes (sbx)
read_when:
  - You want OpenClaw to sandbox tools with the Docker Sandboxes sbx CLI
  - You are setting up the sbx plugin
  - You want a Docker-backed sandbox managed outside OpenClaw's built-in docker backend
---

Docker Sandboxes is a sandbox backend for OpenClaw built on the `sbx` CLI
(equivalently `docker sandbox`). Instead of OpenClaw driving the Docker engine
directly through its built-in `docker` backend, OpenClaw delegates sandbox
lifecycle to `sbx`, which provisions an isolated container, bind-mounts the host
workspace into it, and runs commands through `sbx exec`.

Like the built-in [Docker backend](/gateway/sandboxing#docker-backend), the host
workspace is mounted at the same path inside the sandbox, so file edits are
visible on the host immediately. No mirror/upload step is needed.

## Prerequisites

- sbx plugin installed (`openclaw plugins install @openclaw/sbx-sandbox`)
- The `sbx` CLI installed and on `PATH` (or set a custom path via
  `plugins.entries.sbx.config.command`). See the
  [Docker Sandboxes project](https://github.com/docker/sandboxes) for install
  options (Docker Desktop, standalone binary, or build from source).
- Docker Desktop or Docker Engine running on the host
- OpenClaw Gateway running on the host

## Quick start

1. Install and enable the plugin, then set the sandbox backend:

```bash
openclaw plugins install @openclaw/sbx-sandbox
```

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "sbx",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      sbx: {
        enabled: true,
        config: {
          agent: "shell",
        },
      },
    },
  },
}
```

2. Restart the Gateway. On the next agent turn, OpenClaw creates an sbx sandbox
   and routes tool execution through it.

3. Verify:

```bash
openclaw sandbox list
openclaw sandbox explain
```

## Configuration reference

All sbx config lives under `plugins.entries.sbx.config`:

| Key              | Type      | Default   | Description                                                           |
| ---------------- | --------- | --------- | --------------------------------------------------------------------- |
| `command`        | `string`  | `"sbx"`   | Path or name of the `sbx` CLI                                         |
| `agent`          | `string`  | `"shell"` | Docker Sandboxes agent used at create time (`sbx create <agent> ...`) |
| `template`       | `string`  | —         | Container image override (`--template`)                               |
| `cpus`           | `number`  | —         | CPUs to allocate (`--cpus`; 0 = all host CPUs)                        |
| `memory`         | `string`  | —         | Memory limit in binary units, for example `8g` (`--memory`)           |
| `user`           | `string`  | —         | Username or UID for command execution (`sbx exec -u`)                 |
| `clone`          | `boolean` | `false`   | Use an in-container Git clone instead of a bind mount (`--clone`)     |
| `timeoutSeconds` | `number`  | `120`     | Timeout for `sbx` CLI operations                                      |

Sandbox-level settings (`mode`, `scope`, `workspaceAccess`) are configured under
`agents.defaults.sandbox` as with any backend. See
[Sandboxing](/gateway/sandboxing) for the full matrix.

<Warning>
With `clone: true` the workspace is mounted read-only and the agent works on an in-container clone. Host files are not updated until the agent's commits are pulled through the `sandbox-<name>` git remote. Leave `clone` disabled if you want the default bind-mount behavior where writes appear on the host.
</Warning>

## Examples

### Minimal setup

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "sbx",
      },
    },
  },
  plugins: {
    entries: {
      sbx: {
        enabled: true,
      },
    },
  },
}
```

### Custom image with resource limits

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "sbx",
        scope: "agent",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      sbx: {
        enabled: true,
        config: {
          agent: "shell",
          template: "ghcr.io/example/sandbox:latest",
          cpus: 4,
          memory: "8g",
          timeoutSeconds: 180,
        },
      },
    },
  },
}
```

### Per-agent sbx sandbox

```json5
{
  agents: {
    defaults: {
      sandbox: { mode: "off" },
    },
    list: [
      {
        id: "researcher",
        sandbox: {
          mode: "all",
          backend: "sbx",
          scope: "agent",
          workspaceAccess: "rw",
        },
      },
    ],
  },
  plugins: {
    entries: {
      sbx: {
        enabled: true,
        config: { agent: "shell" },
      },
    },
  },
}
```

## Lifecycle management

sbx sandboxes are managed through the normal sandbox CLI:

```bash
# List all sandbox runtimes (built-in Docker + sbx)
openclaw sandbox list

# Inspect effective policy
openclaw sandbox explain

# Recreate (removes the sbx sandbox; a fresh one is created on next use)
openclaw sandbox recreate --all
```

Recreate after changing any of these:

- `agents.defaults.sandbox.backend`
- `plugins.entries.sbx.config.agent`
- `plugins.entries.sbx.config.template`

```bash
openclaw sandbox recreate --all
```

## Current limitations

- Sandbox browser is not supported on the sbx backend.
- `sandbox.docker.binds` does not apply to sbx; the host workspace (and, when
  enabled, the agent and skills workspaces) are mounted automatically.
- Docker-specific runtime knobs under `sandbox.docker.*` apply only to the
  built-in Docker backend. Use `plugins.entries.sbx.config` for sbx options.

## How it works

1. OpenClaw calls `sbx create <agent> <workspace> --name <name>` (with
   `--template`, `--cpus`, `--memory`, and `--clone` flags as configured) the
   first time a sandbox scope is used.
2. The host workspace is bind-mounted at the same path inside the sandbox, so
   file tools and exec operate on the shared workspace directly.
3. Command execution runs through `sbx exec`, using a login shell so custom
   PATH entries survive `/etc/profile`.
4. File tools read and write through the sandbox using `sbx exec`-backed shell
   commands.

## Related

- [Sandboxing](/gateway/sandboxing) -- modes, scopes, and backend comparison
- [OpenShell](/gateway/openshell) -- managed remote sandbox backend
- [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) -- debugging blocked tools
- [Multi-Agent Sandbox and Tools](/tools/multi-agent-sandbox-tools) -- per-agent overrides
- [Sandbox CLI](/cli/sandbox) -- `openclaw sandbox` commands
