---
summary: "Run OpenClaw in a rootless Podman container"
read_when:
  - You want a containerized gateway with Podman instead of Docker
title: "Podman"
---

# Podman

Run the OpenClaw Gateway in a rootless Podman container, managed by your current non-root user.

The intended model is:

- Podman runs the gateway container.
- Your host `openclaw` CLI is the control plane.
- Persistent state lives on the host under `~/.openclaw` by default.
- Day-to-day management uses `openclaw --container <name> ...` instead of `sudo -u openclaw`, `podman exec`, or a separate service user.

## Prerequisites

- **Podman** in rootless mode
- **OpenClaw CLI** installed on the host
- **Optional:** `systemd --user` if you want Quadlet-managed auto-start
- **Optional:** `sudo` only if you want `loginctl enable-linger "$(whoami)"` for boot persistence on a headless host

## Quick start

<Steps>
  <Step title="One-time setup">
    From the repo root, run:

    ```bash
    ./scripts/podman/setup.sh
    ```

    This:

    - builds `openclaw:local` in your rootless Podman store (or uses `OPENCLAW_IMAGE` if you set one)
    - creates `~/.openclaw/openclaw.json` with `gateway.mode: "local"` if missing
    - creates `~/.openclaw/.env` with `OPENCLAW_GATEWAY_TOKEN` if missing
    - installs `run-openclaw-podman.sh` to `~/.local/bin/run-openclaw-podman.sh`

    For a Quadlet-managed user service instead of manual container start:

    ```bash
    ./scripts/podman/setup.sh --quadlet
    ```

    Or set `OPENCLAW_PODMAN_QUADLET=1`.

    Optional build/setup env vars:

    - `OPENCLAW_IMAGE` or `OPENCLAW_PODMAN_IMAGE` -- use an existing/pulled image instead of building `openclaw:local`
    - `OPENCLAW_DOCKER_APT_PACKAGES` -- install extra apt packages during image build
    - `OPENCLAW_EXTENSIONS` -- pre-install extension dependencies at build time

  </Step>

  <Step title="Start the Gateway container">
    Manual start:

    ```bash
    ~/.local/bin/run-openclaw-podman.sh launch
    ```

    The script starts the container as your current uid/gid with `--userns=keep-id` and bind-mounts your OpenClaw state into the container.

  </Step>

  <Step title="Run onboarding inside the container">
    To configure providers or channels interactively:

    ```bash
    ~/.local/bin/run-openclaw-podman.sh launch setup
    ```

    Then open `http://127.0.0.1:18789/` and use the token from `~/.openclaw/.env`.

  </Step>

  <Step title="Manage the running container from the host CLI">
    The expected UX is to keep using the normal `openclaw` CLI on the host and target the running container:

    ```bash
    openclaw --container openclaw dashboard --no-open
    openclaw --container openclaw gateway status --deep
    openclaw --container openclaw doctor
    openclaw --container openclaw channels login
    openclaw --container openclaw channels add --channel telegram --token "<token>"
    ```

    If you do this often, set a shell default:

    ```bash
    export OPENCLAW_CONTAINER=openclaw
    ```

    Then normal commands such as `openclaw status`, `openclaw dashboard --no-open`, and `openclaw channels login` will run inside that container automatically.

  </Step>
</Steps>

## Expected UX

This is the intended day-to-day workflow for Podman:

1. Start or restart the gateway container with `run-openclaw-podman.sh` or `systemctl --user`.
2. Use the host CLI with `--container openclaw` for status, doctor, dashboard, onboarding, channels, and other gateway-backed commands.
3. Use `podman logs`, `podman stop`, and `podman rm` only for container/runtime operations.
4. Rebuild or pull a new image to update the container image. `openclaw update` is intentionally blocked with `--container`.

In other words: the container owns the gateway process, and the host CLI owns operator workflows.

## Systemd (Quadlet, optional)

If you ran `./scripts/podman/setup.sh --quadlet`, setup installs a Quadlet file at:

```bash
~/.config/containers/systemd/openclaw.container
```

Useful commands:

- **Start:** `systemctl --user start openclaw.service`
- **Stop:** `systemctl --user stop openclaw.service`
- **Status:** `systemctl --user status openclaw.service`
- **Logs:** `journalctl --user -u openclaw.service -f`

After editing the Quadlet file:

```bash
systemctl --user daemon-reload
systemctl --user restart openclaw.service
```

For boot persistence on SSH/headless hosts, enable lingering for your current user:

```bash
sudo loginctl enable-linger "$(whoami)"
```

## Config, env, and storage

- **Config dir:** `~/.openclaw`
- **Workspace dir:** `~/.openclaw/workspace`
- **Token file:** `~/.openclaw/.env`
- **Launch helper:** `~/.local/bin/run-openclaw-podman.sh`

The launch script and Quadlet bind-mount host state into the container:

- `OPENCLAW_CONFIG_DIR` -> `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR` -> `/home/node/.openclaw/workspace`

By default those are host directories, not anonymous container state, so config and workspace survive container replacement.

Useful env vars:

- `OPENCLAW_PODMAN_CONTAINER` -- container name (`openclaw` by default)
- `OPENCLAW_PODMAN_IMAGE` / `OPENCLAW_IMAGE` -- image to run
- `OPENCLAW_PODMAN_GATEWAY_HOST_PORT` -- host port mapped to container `18789`
- `OPENCLAW_PODMAN_BRIDGE_HOST_PORT` -- host port mapped to container `18790`
- `OPENCLAW_GATEWAY_BIND` -- gateway bind mode inside the container; default is `loopback`
- `OPENCLAW_PODMAN_USERNS` -- `keep-id` (default), `auto`, or `host`

The launcher reads `~/.openclaw/.env` before finalizing container/image defaults, so you can persist these there.

## Useful commands

- **Container logs:** `podman logs -f openclaw`
- **Stop container:** `podman stop openclaw`
- **Remove container:** `podman rm -f openclaw`
- **Open dashboard URL from host CLI:** `openclaw --container openclaw dashboard --no-open`
- **Health/status via host CLI:** `openclaw --container openclaw gateway status --deep`

## Troubleshooting

- **Permission denied (EACCES) on config or workspace:** The container runs with `--userns=keep-id` and `--user <your uid>:<your gid>` by default. Ensure the host config/workspace paths are owned by your current user.
- **Gateway start blocked (missing `gateway.mode=local`):** Ensure `~/.openclaw/openclaw.json` exists and sets `gateway.mode="local"`. `scripts/podman/setup.sh` creates this if missing.
- **Container CLI commands hit the wrong target:** Use `openclaw --container <name> ...` explicitly, or export `OPENCLAW_CONTAINER=<name>` in your shell.
- **`openclaw update` fails with `--container`:** Expected. Rebuild/pull the image, then restart the container or the Quadlet service.
- **Quadlet service does not start:** Run `systemctl --user daemon-reload`, then `systemctl --user start openclaw.service`. On headless systems you may also need `sudo loginctl enable-linger "$(whoami)"`.
- **SELinux blocks bind mounts:** Leave the default mount behavior alone; the launcher auto-adds `:Z` on Linux when SELinux is enforcing or permissive.

## Related

- [Docker](/install/docker)
- [Gateway background process](/gateway/background-process)
- [Gateway troubleshooting](/gateway/troubleshooting)
