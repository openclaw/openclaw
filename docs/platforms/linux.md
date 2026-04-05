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

1. Install Node 24 (recommended; Node 22 LTS, currently `22.14+`, still works for compatibility)
2. `npm i -g mullusi@latest`
3. `mullusi onboard --install-daemon`
4. From your laptop: `ssh -N -L 18790:127.0.0.1:18790 <user>@<host>`
5. Open `http://127.0.0.1:18790/` and authenticate with the configured shared secret (token by default; password if you set `gateway.auth.mode: "password"`)

Full Linux server guide: [Linux Server](/vps). Step-by-step VPS example: [exe.dev](/install/exe-dev)

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
mullusi onboard --install-daemon
```

Or:

```
mullusi gateway install
```

Or:

```
mullusi configure
```

Select **Gateway service** when prompted.

Repair/migrate:

```
mullusi doctor
```

## System control (systemd user unit)

Mullusi installs a systemd **user** service by default. Use a **system**
service for shared or always-on servers. `mullusi gateway install` and
`mullusi onboard --install-daemon` already render the current canonical unit
for you; write one by hand only when you need a custom system/service-manager
setup. The full service guidance lives in the [Gateway runbook](/gateway).

Minimal setup:

Create `~/.config/systemd/user/mullusi-gateway[-<profile>].service`:

```
[Unit]
Description=Mullusi Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/mullusi gateway --port 18790
Restart=always
RestartSec=5
TimeoutStopSec=30
TimeoutStartSec=30
SuccessExitStatus=0 143
KillMode=control-group

[Install]
WantedBy=default.target
```

Enable it:

```
systemctl --user enable --now mullusi-gateway[-<profile>].service
```
