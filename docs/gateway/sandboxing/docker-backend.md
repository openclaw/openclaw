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

To expose host GPUs, set `agents.defaults.sandbox.docker.gpus` (or the per-agent override) to a value like `"all"` or `"device=GPU-uuid"`. This is passed to the selected container engine's Docker-compatible `--gpus` flag and requires compatible host GPU setup. Podman requires version 5.0 or newer for this option.

<Warning>
**Docker-out-of-Docker (DooD) constraints**

If you deploy the OpenClaw Gateway itself as a Docker container, it orchestrates sibling sandbox containers using the host's Docker socket (DooD). This introduces a path mapping constraint:

- **Config requires host paths**: `openclaw.json` `workspace` must contain the **host's absolute path** (e.g. `/home/user/.openclaw/workspaces`), not the internal Gateway container path. The Docker daemon evaluates paths relative to the host OS namespace, not the Gateway's own namespace.
- **Matching volume map required**: The Gateway process also writes bridge files to that `workspace` path. Give the Gateway container an identical volume map (`-v /home/user/.openclaw:/home/user/.openclaw`) so the same host path resolves correctly from inside the Gateway container too. Mismatched mappings surface as `EACCES` when the Gateway writes workspace files.
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
