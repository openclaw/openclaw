---
summary: "Selecting the native Podman CLI, rootless user mapping, and Podman-outside-of-Podman constraints"
title: "Podman backend"
read_when: "You are using Podman instead of Docker for sandboxed tool execution."
---

Selecting the native Podman CLI as a built-in backend, the Docker settings it reuses, and its rootless user-mapping rules.

This page covers Podman as the sandbox backend for agent tool execution. Running the Gateway itself in a rootless Podman container is a separate setup: see [Podman](/install/podman).

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

## Changing connections and upgrading existing sandboxes

OpenClaw follows the installed Podman **client** when both environment selectors are set:
Podman 4.8 and newer prefer a nonempty `CONTAINER_CONNECTION`; Podman 4.7 prefers
`CONTAINER_HOST` when it is present. The engine's server version does not decide
this precedence. If OpenClaw cannot identify the client version with both selectors
set, it refuses the ambiguous selection. Unset the unused selector or repair the
client's `podman --version` command.

Each sandbox records its engine URI and, for Podman Machine, its SSH identity.
Earlier OpenClaw versions could pin `CONTAINER_HOST` even when the client selected
`CONTAINER_CONNECTION`. After upgrading, those existing sandboxes can report
"The active Podman connection changed." OpenClaw preserves the old sandbox and
registry entry rather than removing a container on the newly selected engine.

Retire the old sandbox through its recorded endpoint before switching:

1. Pause runs that use the affected sandbox. Use the same OS user, OpenClaw profile,
   config, and state directory as the Gateway for the commands below.
2. Restore the original `CONTAINER_HOST` and, for Podman Machine, the original
   `CONTAINER_SSHKEY`. Unset `CONTAINER_CONNECTION` in that command environment.
   The original endpoint must be reachable, and a Podman Machine must be running.
3. Use the affected sandbox's exact `sessionKey`. While all registered sandboxes
   use the restored target, `openclaw sandbox list --json` shows that key and the
   recorded URI and identity in `backendTarget.globalArgs`. Save these values before
   changing connections. If entries already span engines, the global list can fail;
   use the previously recorded key with the scoped recreation below. If that key is
   unknown, preserve the registry and identify the exact scope before continuing.
4. Preserve any needed data in the container's writable layer, then run
   `openclaw sandbox recreate --session "<sessionKey>"`. Review the preview before
   confirming. This removes the selected container; mounted workspace files remain.
5. Set the intended `CONTAINER_CONNECTION` and unset the unused `CONTAINER_HOST`
   and `CONTAINER_SSHKEY`. Apply that environment to the Gateway as well. Ensure the
   sandbox image and workspace are available on the selected engine. The next use
   creates a new sandbox there; it does not transfer the old container's writable layer.

If the original endpoint or identity cannot be restored, keep the registry entry
and repair that connection first. Do not edit the recorded target or delete the
registry entry to bypass the check. `recreate --force` only skips confirmation;
it does not bypass endpoint validation.

## Host init prerequisite

OpenClaw creates Podman sandboxes with `--init` so orphaned tool processes are reaped. The Podman engine host needs its init executable, normally `catatonit`. Installing it only inside the sandbox image does not satisfy this requirement. For Podman Machine, the executable belongs inside the machine, not on the client host.

On Debian or Ubuntu, minimal installs using `--no-install-recommends` can omit the helper. Include it explicitly when provisioning the engine host:

```bash
sudo apt-get install podman catatonit
```

If sandbox creation reports `lookup init binary` or `container-init binary not found on the host`, install the helper or repair Podman's configured `init_path`/`helper_binaries_dir` in `containers.conf`, then retry. Podman can resolve helpers outside `PATH`; a successful `podman info` does not prove that `--init` works. Keep sandboxing and `--init` enabled rather than bypassing this prerequisite.

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
