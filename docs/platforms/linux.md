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

## WSL2 Troubleshooting

On WSL2 (Ubuntu), systemd user sessions sometimes fail to initialize the DBus socket on boot. This breaks systemd-dependent services including the OpenClaw Gateway.

### Symptoms

- Gateway fails to start with DBus-related errors
- `systemctl --user` commands fail
- Missing `/run/user/$(id -u)/bus` socket

### Fix

Restart the user session service:

```bash
sudo systemctl restart user@$(id -u).service
```

### Verify

After restarting, confirm the socket exists:

```bash
ls -la /run/user/$(id -u)/bus
```

Then restart the gateway (adjust for your profile if not using default):

```bash
systemctl --user restart openclaw-gateway.service
# Or with a profile: openclaw-gateway-<profile>.service
```

### Persistent Fix

Add to your `.profile` or `.zprofile` (login shell, runs once per session):

```sh
# WSL2 DBus socket fix (login shell) — runs once per login session.
# Note: may prompt for your sudo password once.
uid="$(id -u)"
if [ -n "${WSL_DISTRO_NAME-}" ] && [ ! -S "/run/user/${uid}/bus" ]; then
  sudo systemctl restart "user@${uid}.service" 2>/dev/null
fi
```

> **Note:** This uses `.profile` (not `.bashrc`) to avoid repeated sudo prompts in subshells.
