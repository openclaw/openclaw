---
summary: "Docker backend defaults, the restricted runtime posture, DooD constraints, and the sandboxed browser"
title: "Docker backend"
read_when: "You are running the default local sandbox backend or enabling the sandboxed browser."
---

The default local backend: its restricted defaults, GPU and Docker-out-of-Docker constraints, and the sandboxed browser container.

## Docker backend

The Docker backend runs tools locally through the `docker` CLI. Its selection and error behavior are unchanged; it does not probe or fall back to Podman.

Defaults: `network: "none"` (no egress), `readOnlyRoot: true`, `capDrop: ["ALL"]`, image `openclaw-sandbox:bookworm-slim`.

This explicit configuration keeps the agent workspace read-only and preserves
the default restricted runtime posture:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "docker",
        scope: "session",
        workspaceAccess: "ro",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          capDrop: ["ALL"],
        },
      },
    },
  },
}
```

OpenClaw also creates Docker sandbox containers with an init process and
`no-new-privileges`. With `workspaceAccess: "ro"`, the agent workspace is
mounted read-only at `/agent`; write operations to the agent workspace are
rejected, while the configured tmpfs paths remain writable.

File tools require a host-backed bind mount. A tmpfs or image volume can hide
files below a workspace bind; file tools report those paths as container-only
instead of reading the hidden host files. Use `exec` to access that storage.
A deeper explicit bind restores file-tool access when it is visible in the
container. Mount destinations reached through symlinks, or stacked mounts with
different backing storage, also require `exec` when their host projection cannot
be established from the container's mount table.

For recently used containers, changes to bind sources or access modes, or to
tmpfs destinations or read-only modes below a bind, require scoped recreation.
Other tmpfs options, such as size, mode, and uid, keep the normal configuration
change behavior: a hot container stays running with a recreation notice, while
a stopped or expired container is replaced. Recreate explicitly to apply those
options immediately.

To expose host GPUs, set `agents.defaults.sandbox.docker.gpus` (or the per-agent override) to a value like `"all"` or `"device=GPU-uuid"`. This is passed to the selected container engine's Docker-compatible `--gpus` flag and requires compatible host GPU setup. Podman requires version 5.0 or newer for this option.

<Warning>
**Docker-out-of-Docker (DooD) constraints**

If the Gateway runs in Docker, it creates sibling sandbox containers through the host's Docker socket.
Keep workspace paths in `openclaw.json` relative to the Gateway filesystem, such as `/home/node/.openclaw/workspace`.
OpenClaw translates managed workspace, agent-workspace, and skill mounts into the Docker host's paths automatically.
Shell and browser containers use the same mapping rules.
Nested Gateway binds are projected too, with their read-only permissions preserved.

- Bind-mount the workspace and OpenClaw state directories into the Gateway. Their host and Gateway paths can differ.
- Use the Docker daemon that runs the Gateway. OpenClaw verifies its container identity before trusting the daemon's mount table.
- Managed sources and their visible nested mounts must come from bind mounts. Named volumes, tmpfs, and files in the Gateway image are unsupported sources for sibling sandbox mounts.
- A writable sandbox requires a writable Gateway bind. Use `workspaceAccess: "ro"` for read-only Gateway sources.
- Explicit `sandbox.docker.binds` and `sandbox.browser.binds` retain their host-path contract. OpenClaw does not translate these operator-supplied sources.
- Restart the Gateway after changing its mounts or Docker connection. If an existing sandbox has different mounts, OpenClaw reports a scoped `sandbox recreate` command.
  Recently used containers remain running until you recreate them, but OpenClaw refuses to reuse their stale mounts.

- **Codex code mode**: when an OpenClaw sandbox is active, OpenClaw disables Codex app-server native Code Mode, user MCP servers, and app-backed plugin execution for that turn (those run from the Gateway-host app-server process, not the OpenClaw sandbox backend), unless the sandbox tool policy exposes the required tools and you opt into the experimental sandbox exec-server path. Shell access then routes through OpenClaw sandbox-backed tools such as `sandbox_exec` and `sandbox_process`. Do not mount the host Docker socket into agent sandbox containers or custom Codex sandboxes. See [Codex Harness](/plugins/codex-harness) for the full behavior.

On Ubuntu/AppArmor hosts with Docker sandbox mode enabled, Codex app-server `workspace-write` shell execution needs unprivileged user namespaces inside the sandbox container, and this can fail before shell startup when the service user cannot create them. This needs an unprivileged network namespace too when Docker sandbox egress is disabled (`network: "none"`, the default). Common symptoms: `bwrap: setting up uid map: Permission denied` and `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. Run `openclaw doctor`; if it reports a Codex bwrap namespace probe failure, prefer an AppArmor profile that grants the required namespaces to the OpenClaw service process. `kernel.apparmor_restrict_unprivileged_userns=0` is a host-wide fallback with security tradeoffs; use it only when that host posture is acceptable.
</Warning>

### Sandboxed browser

- The sandbox browser auto-starts (ensures CDP is reachable) when the browser tool needs it. Configure via `agents.defaults.sandbox.browser.autoStart` (default `true`) and `autoStartTimeoutMs` (default 12s).
- Sandbox browser containers use a dedicated Docker network (`openclaw-sandbox-browser`) instead of the global `bridge` network. Configure with `agents.defaults.sandbox.browser.network`.
- Sandbox browser network mode `"none"` is unsupported because browser control requires host-published CDP ports. Use the dedicated default, `bridge`, or another custom bridge network. `openclaw doctor --fix` disables affected persisted sidecars and restores the dedicated network without silently enabling egress.
- `agents.defaults.sandbox.browser.cdpSourceRange` restricts container-edge CDP ingress with a CIDR allowlist (for example `172.21.0.1/32`).
- noVNC observer access is password-protected by default; OpenClaw emits a short-lived token URL that serves a local bootstrap page and opens noVNC with the password in the URL fragment (not query string or header logs).
- `agents.defaults.sandbox.browser.allowHostControl` (default `false`) lets sandboxed sessions target the host browser explicitly.
- Optional allowlists gate `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.
