---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "How OpenClaw sandboxing works: modes, scopes, workspace access, and images"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: Sandboxing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when: "You want a dedicated explanation of sandboxing or need to tune agents.defaults.sandbox."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: active（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Sandboxing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can run **tools inside Docker containers** to reduce blast radius.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is **optional** and controlled by configuration (`agents.defaults.sandbox` or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.list[].sandbox`). If sandboxing is off, tools run on the host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway stays on the host; tool execution runs in an isolated sandbox（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
when enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is not a perfect security boundary, but it materially limits filesystem（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and process access when the model does something dumb.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What gets sandboxed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool execution (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional sandboxed browser (`agents.defaults.sandbox.browser`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - By default, the sandbox browser auto-starts (ensures CDP is reachable) when the browser tool needs it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Configure via `agents.defaults.sandbox.browser.autoStart` and `agents.defaults.sandbox.browser.autoStartTimeoutMs`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `agents.defaults.sandbox.browser.allowHostControl` lets sandboxed sessions target the host browser explicitly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional allowlists gate `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Not sandboxed:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The Gateway process itself.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Any tool explicitly allowed to run on the host (e.g. `tools.elevated`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Elevated exec runs on the host and bypasses sandboxing.**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If sandboxing is off, `tools.elevated` does not change execution (already on host). See [Elevated Mode](/tools/elevated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.sandbox.mode` controls **when** sandboxing is used:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"off"`: no sandboxing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"non-main"`: sandbox only **non-main** sessions (default if you want normal chats on host).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"all"`: every session runs in a sandbox.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Note: `"non-main"` is based on `session.mainKey` (default `"main"`), not agent id.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Group/channel sessions use their own keys, so they count as non-main and will be sandboxed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.sandbox.scope` controls **how many containers** are created:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"session"` (default): one container per session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"agent"`: one container per agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"shared"`: one container shared by all sandboxed sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Workspace access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.sandbox.workspaceAccess` controls **what the sandbox can see**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"none"` (default): tools see a sandbox workspace under `~/.openclaw/sandboxes`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"ro"`: mounts the agent workspace read-only at `/agent` (disables `write`/`edit`/`apply_patch`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"rw"`: mounts the agent workspace read/write at `/workspace`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inbound media is copied into the active sandbox workspace (`media/inbound/*`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skills note: the `read` tool is sandbox-rooted. With `workspaceAccess: "none"`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw mirrors eligible skills into the sandbox workspace (`.../skills`) so（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
they can be read. With `"rw"`, workspace skills are readable from（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/workspace/skills`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Custom bind mounts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.sandbox.docker.binds` mounts additional host directories into the container.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Format: `host:container:mode` (e.g., `"/home/user/source:/source:rw"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Global and per-agent binds are **merged** (not replaced). Under `scope: "shared"`, per-agent binds are ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (read-only source + docker socket):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        docker: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "build",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          docker: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            binds: ["/mnt/cache:/cache:rw"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Binds bypass the sandbox filesystem: they expose host paths with whatever mode you set (`:ro` or `:rw`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sensitive mounts (e.g., `docker.sock`, secrets, SSH keys) should be `:ro` unless absolutely required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Combine with `workspaceAccess: "ro"` if you only need read access to the workspace; bind modes stay independent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for how binds interact with tool policy and elevated exec.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Images + setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default image: `openclaw-sandbox:bookworm-slim`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Build it once:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/sandbox-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: the default image does **not** include Node. If a skill needs Node (or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
other runtimes), either bake a custom image or install via（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`sandbox.docker.setupCommand` (requires network egress + writable root +（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
root user).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sandboxed browser image:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/sandbox-browser-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, sandbox containers run with **no network**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Override with `agents.defaults.sandbox.docker.network`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docker installs and the containerized gateway live here:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Docker](/install/docker)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## setupCommand (one-time container setup)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`setupCommand` runs **once** after the sandbox container is created (not on every run).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It executes inside the container via `sh -lc`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Paths:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Global: `agents.defaults.sandbox.docker.setupCommand`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-agent: `agents.list[].sandbox.docker.setupCommand`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common pitfalls:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default `docker.network` is `"none"` (no egress), so package installs will fail.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `readOnlyRoot: true` prevents writes; set `readOnlyRoot: false` or bake a custom image.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `user` must be root for package installs (omit `user` or set `user: "0:0"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox exec does **not** inherit host `process.env`. Use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `agents.defaults.sandbox.docker.env` (or a custom image) for skill API keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool policy + escape hatches（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tool allow/deny policies still apply before sandbox rules. If a tool is denied（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
globally or per-agent, sandboxing doesn’t bring it back.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.elevated` is an explicit escape hatch that runs `exec` on the host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/exec` directives only apply for authorized senders and persist per session; to hard-disable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`exec`, use tool policy deny (see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Debugging:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `openclaw sandbox explain` to inspect effective sandbox mode, tool policy, and fix-it config keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for the “why is this blocked?” mental model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Keep it locked down.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Multi-agent overrides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each agent can override sandbox + tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.list[].sandbox` and `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools` for sandbox tool policy).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for precedence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Minimal enable example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        mode: "non-main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        scope: "session",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspaceAccess: "none",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Security](/gateway/security)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
