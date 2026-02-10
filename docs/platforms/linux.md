---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Linux support + companion app status"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Looking for Linux companion app status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Planning platform coverage or contributions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Linux App"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Linux App（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway is fully supported on Linux. **Node is the recommended runtime**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bun is not recommended for the Gateway (WhatsApp/Telegram bugs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Native Linux companion apps are planned. Contributions are welcome if you want to help build one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Beginner quick path (VPS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install Node 22+（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `npm i -g openclaw@latest`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `openclaw onboard --install-daemon`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. From your laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Open `http://127.0.0.1:18789/` and paste your token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Step-by-step VPS guide: [exe.dev](/install/exe-dev)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Getting Started](/start/getting-started)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Install & updates](/install/updating)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional flows: [Bun (experimental)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway runbook](/gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway service install (CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use one of these:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --install-daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw configure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Select **Gateway service** when prompted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Repair/migrate:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## System control (systemd user unit)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw installs a systemd **user** service by default. Use a **system**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
service for shared or always-on servers. The full unit example and guidance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
live in the [Gateway runbook](/gateway).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal setup:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Unit]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Description=OpenClaw Gateway (profile: <profile>, v<version>)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After=network-online.target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Wants=network-online.target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Service]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ExecStart=/usr/local/bin/openclaw gateway --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart=always（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RestartSec=5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Install]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WantedBy=default.target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
systemctl --user enable --now openclaw-gateway[-<profile>].service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
