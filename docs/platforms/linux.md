---
summary: "Linux support + companion app status"
read_when:
  - Looking for Linux companion app status
  - Planning platform coverage or contributions
title: "Linux App"
---

# Linux App

The Gateway is fully supported on Linux. **Node is the recommended runtime**.
Bun is not recommended for the Gateway (WhatsApp/Telegram bugs).

Native Linux companion apps are planned. Contributions are welcome if you want to help build one.

## Beginner quick path (VPS)

1. Install Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. From your laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Open `http://127.0.0.1:18789/` and paste your token

Step-by-step VPS guide: [exe.dev](/install/exe-dev)

## Docker Compose on Linux Hosts (EC2)

If you run the Gateway and CLI in Docker on Linux, expect a few Linux-specific gotchas:

- Use a separate config dir for the CLI container so it can run in `gateway.mode=remote` without breaking the Gateway (which must stay `gateway.mode=local`). Example: mount `OPENCLAW_CLI_CONFIG_DIR` to `/home/node/.openclaw` in the CLI service.
- Run containers as your host UID/GID to avoid `EACCES` on mounted config: set `user: "${OPENCLAW_UID}:${OPENCLAW_GID}"` and export those in `.env`.
- If a host log directory is owned by a specific service group (for example `apache`), add that GID to the container via `group_add` so the container user can read it (example: `group_add: ["48"]`).
- If SELinux is enforcing, add `:z` to bind mounts (for example `/var/log/php-fpm:/home/node/logs/php-fpm:ro,z`).
- If the host log directory is restricted (for example `apache:root` with `600` files), add the group to the container (`group_add: ["48"]`) and set ACLs on the host so files are readable.
- If you split compose files, include all of them via `COMPOSE_FILE=...` so mounts and host tweaks are applied.
- Control UI over HTTP requires `gateway.controlUi.allowInsecureAuth: true` and a gateway token in the UI (or use HTTPS/localhost).
- WhatsApp is a bundled plugin (disabled by default); enable it in both Gateway config and CLI config if those are separate.

## Install

- [Getting Started](/start/getting-started)
- [Install & updates](/install/updating)
- Optional flows: [Bun (experimental)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

Use one of these:

```
openclaw onboard --install-daemon
```

Or:

```
openclaw gateway install
```

Or:

```
openclaw configure
```

Select **Gateway service** when prompted.

Repair/migrate:

```
openclaw doctor
```

## System control (systemd user unit)

OpenClaw installs a systemd **user** service by default. Use a **system**
service for shared or always-on servers. The full unit example and guidance
live in the [Gateway runbook](/gateway).

Minimal setup:

Create `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable it:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
