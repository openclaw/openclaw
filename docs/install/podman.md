---
summary: "Run SmartAgentNeo in a rootless Podman container"
read_when:
  - You want a containerized gateway with Podman instead of Docker
title: "Podman"
---

# Podman

Run the SmartAgentNeo gateway in a **rootless** Podman container. Uses the same image as Docker (build from the repo [Dockerfile](https://github.com/betterbrand/smart-agent-neo/blob/main/Dockerfile)).

## Requirements

- Podman (rootless)
- Sudo for one-time setup (create user, build image)

## Quick start

**1. One-time setup** (from repo root; creates user, builds image, installs launch script):

```bash
./setup-podman.sh
```

This also creates a minimal `~smart-agent-neo/.smart-agent-neo/smart-agent-neo.json` (sets `gateway.mode="local"`) so the gateway can start without running the wizard.

By default the container is **not** installed as a systemd service, you start it manually (see below). For a production-style setup with auto-start and restarts, install it as a systemd Quadlet user service instead:

```bash
./setup-podman.sh --quadlet
```

(Or set `SMART_AGENT_NEO_PODMAN_QUADLET=1`; use `--container` to install only the container and launch script.)

**2. Start gateway** (manual, for quick smoke testing):

```bash
./scripts/run-smart-agent-neo-podman.sh launch
```

**3. Onboarding wizard** (e.g. to add channels or providers):

```bash
./scripts/run-smart-agent-neo-podman.sh launch setup
```

Then open `http://127.0.0.1:18789/` and use the token from `~smart-agent-neo/.smart-agent-neo/.env` (or the value printed by setup).

## Systemd (Quadlet, optional)

If you ran `./setup-podman.sh --quadlet` (or `SMART_AGENT_NEO_PODMAN_QUADLET=1`), a [Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) unit is installed so the gateway runs as a systemd user service for the smart-agent-neo user. The service is enabled and started at the end of setup.

- **Start:** `sudo systemctl --machine smart-agent-neo@ --user start smart-agent-neo.service`
- **Stop:** `sudo systemctl --machine smart-agent-neo@ --user stop smart-agent-neo.service`
- **Status:** `sudo systemctl --machine smart-agent-neo@ --user status smart-agent-neo.service`
- **Logs:** `sudo journalctl --machine smart-agent-neo@ --user -u smart-agent-neo.service -f`

The quadlet file lives at `~smart-agent-neo/.config/containers/systemd/smart-agent-neo.container`. To change ports or env, edit that file (or the `.env` it sources), then `sudo systemctl --machine smart-agent-neo@ --user daemon-reload` and restart the service. On boot, the service starts automatically if lingering is enabled for smart-agent-neo (setup does this when loginctl is available).

To add quadlet **after** an initial setup that did not use it, re-run: `./setup-podman.sh --quadlet`.

## The smart-agent-neo user (non-login)

`setup-podman.sh` creates a dedicated system user `smart-agent-neo`:

- **Shell:** `nologin` — no interactive login; reduces attack surface.
- **Home:** e.g. `/home/smart-agent-neo` — holds `~/.smart-agent-neo` (config, workspace) and the launch script `run-smart-agent-neo-podman.sh`.
- **Rootless Podman:** The user must have a **subuid** and **subgid** range. Many distros assign these automatically when the user is created. If setup prints a warning, add lines to `/etc/subuid` and `/etc/subgid`:

  ```text
  smart-agent-neo:100000:65536
  ```

  Then start the gateway as that user (e.g. from cron or systemd):

  ```bash
  sudo -u smart-agent-neo /home/smart-agent-neo/run-smart-agent-neo-podman.sh
  sudo -u smart-agent-neo /home/smart-agent-neo/run-smart-agent-neo-podman.sh setup
  ```

- **Config:** Only `smart-agent-neo` and root can access `/home/smart-agent-neo/.smart-agent-neo`. To edit config: use the Control UI once the gateway is running, or `sudo -u smart-agent-neo $EDITOR /home/smart-agent-neo/.smart-agent-neo/smart-agent-neo.json`.

## Environment and config

- **Token:** Stored in `~smart-agent-neo/.smart-agent-neo/.env` as `SMART_AGENT_NEO_GATEWAY_TOKEN`. `setup-podman.sh` and `run-smart-agent-neo-podman.sh` generate it if missing (uses `openssl`, `python3`, or `od`).
- **Optional:** In that `.env` you can set provider keys (e.g. `GROQ_API_KEY`, `OLLAMA_API_KEY`) and other SmartAgentNeo env vars.
- **Host ports:** By default the script maps `18789` (gateway) and `18790` (bridge). Override the **host** port mapping with `SMART_AGENT_NEO_PODMAN_GATEWAY_HOST_PORT` and `SMART_AGENT_NEO_PODMAN_BRIDGE_HOST_PORT` when launching.
- **Paths:** Host config and workspace default to `~smart-agent-neo/.smart-agent-neo` and `~smart-agent-neo/.smart-agent-neo/workspace`. Override the host paths used by the launch script with `SMART_AGENT_NEO_CONFIG_DIR` and `SMART_AGENT_NEO_WORKSPACE_DIR`.

## Useful commands

- **Logs:** With quadlet: `sudo journalctl --machine smart-agent-neo@ --user -u smart-agent-neo.service -f`. With script: `sudo -u smart-agent-neo podman logs -f smart-agent-neo`
- **Stop:** With quadlet: `sudo systemctl --machine smart-agent-neo@ --user stop smart-agent-neo.service`. With script: `sudo -u smart-agent-neo podman stop smart-agent-neo`
- **Start again:** With quadlet: `sudo systemctl --machine smart-agent-neo@ --user start smart-agent-neo.service`. With script: re-run the launch script or `podman start smart-agent-neo`
- **Remove container:** `sudo -u smart-agent-neo podman rm -f smart-agent-neo` — config and workspace on the host are kept

## Troubleshooting

- **Permission denied (EACCES) on config or auth-profiles:** The container defaults to `--userns=keep-id` and runs as the same uid/gid as the host user running the script. Ensure your host `SMART_AGENT_NEO_CONFIG_DIR` and `SMART_AGENT_NEO_WORKSPACE_DIR` are owned by that user.
- **Gateway start blocked (missing `gateway.mode=local`):** Ensure `~smart-agent-neo/.smart-agent-neo/smart-agent-neo.json` exists and sets `gateway.mode="local"`. `setup-podman.sh` creates this file if missing.
- **Rootless Podman fails for user smart-agent-neo:** Check `/etc/subuid` and `/etc/subgid` contain a line for `smart-agent-neo` (e.g. `smart-agent-neo:100000:65536`). Add it if missing and restart.
- **Container name in use:** The launch script uses `podman run --replace`, so the existing container is replaced when you start again. To clean up manually: `podman rm -f smart-agent-neo`.
- **Script not found when running as smart-agent-neo:** Ensure `setup-podman.sh` was run so that `run-smart-agent-neo-podman.sh` is copied to smart-agent-neo’s home (e.g. `/home/smart-agent-neo/run-smart-agent-neo-podman.sh`).
- **Quadlet service not found or fails to start:** Run `sudo systemctl --machine smart-agent-neo@ --user daemon-reload` after editing the `.container` file. Quadlet requires cgroups v2: `podman info --format '{{.Host.CgroupsVersion}}'` should show `2`.

## Optional: run as your own user

To run the gateway as your normal user (no dedicated smart-agent-neo user): build the image, create `~/.smart-agent-neo/.env` with `SMART_AGENT_NEO_GATEWAY_TOKEN`, and run the container with `--userns=keep-id` and mounts to your `~/.smart-agent-neo`. The launch script is designed for the smart-agent-neo-user flow; for a single-user setup you can instead run the `podman run` command from the script manually, pointing config and workspace to your home. Recommended for most users: use `setup-podman.sh` and run as the smart-agent-neo user so config and process are isolated.
