---
summary: "Selecting the native Podman CLI, rootless user mapping, and Podman-outside-of-Podman constraints"
title: "Podman backend"
read_when: "You are using Podman instead of Docker for sandboxed tool execution."
---

Selecting the native Podman CLI as a built-in backend, the Docker settings it reuses, and its rootless user-mapping rules.

## Podman backend

Use `sandbox.backend: "podman"` to select the native `podman` CLI directly. This is a built-in backend, not a plugin. It does not probe or select Docker, even when the `docker` executable is installed.

Podman reuses the existing `sandbox.docker.*` settings and the active native `podman` CLI context; it adds no separate connection configuration surface.

Rootless Podman defaults to `--userns=keep-id` for writable workspace mounts. A long-lived sandbox can reserve subordinate IDs and block unrelated `--userns=auto` workloads; remove it before starting those workloads. Set `sandbox.docker.user` to a nonzero numeric UID or UID:GID to control the container user. Rootless Podman rejects UID or GID 0 because Podman 4.x cannot remap namespace root while preserving workspace bind ownership; bake root-required setup into the image or use rootful Podman. Rootful Podman otherwise uses the workspace owner when available.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "podman",
        scope: "session",
        workspaceAccess: "rw",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          network: "none",
          readOnlyRoot: true,
          capDrop: ["ALL"],
        },
      },
    },
  },
}
```

Build or pull the sandbox image into the selected Podman store before enabling the backend. From a source checkout, build the same sandbox Dockerfile with Podman:

```bash
podman build -t openclaw-sandbox:bookworm-slim -f scripts/docker/sandbox/Dockerfile .
```

Podman notes:

- Browser sandboxing is not supported by Podman; keep `sandbox.browser.enabled` off, or install Docker and select `backend: "docker"`.
- Local Podman engines and Podman Machine are supported. Podman Machine bind sources must be under the host home directory, which is its default shared volume. Arbitrary remote Podman connections are rejected; use the SSH backend for remote execution.
- Custom `tmpfs` or bind mounts must not cover `/run/podman-init`; OpenClaw rejects them so sandbox cleanup continues to work.

<Warning>
**Podman-outside-of-Podman constraints**

A containerized Gateway creates sibling sandboxes through the host's local Podman engine or Podman Machine.

- **Use host paths consistently**: configure `workspace` with its host absolute path, then mount the complete state root and workspace into the Gateway at those same paths. Otherwise the sandbox may mount the workspace while the Gateway cannot write skill-workspace files.
- **Podman Machine setup**: bind sources must be under the host home directory. Set the Gateway `HOME` to that path and point `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_CONFIG_DIR` at the canonical mounted state root. The image needs a compatible Podman client, its named connection and SSH identity, plus a dedicated writable SSH directory for known-host metadata.
- **Keep Podman access Gateway-only**: never mount the engine socket, connection material, or SSH identity into agent sandboxes. Arbitrary remote connections are unsupported; use the SSH backend instead.

</Warning>
