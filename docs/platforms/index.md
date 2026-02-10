---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Platform support overview (Gateway + companion apps)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Looking for OS support or install paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Deciding where to run the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Platforms"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Platforms（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw core is written in TypeScript. **Node is the recommended runtime**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bun is not recommended for the Gateway (WhatsApp/Telegram bugs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Companion apps exist for macOS (menu bar app) and mobile nodes (iOS/Android). Windows and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Linux companion apps are planned, but the Gateway is fully supported today.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Native companion apps for Windows are also planned; the Gateway is recommended via WSL2.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Choose your OS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: [macOS](/platforms/macos)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iOS: [iOS](/platforms/ios)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android: [Android](/platforms/android)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows: [Windows](/platforms/windows)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Linux: [Linux](/platforms/linux)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## VPS & hosting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- VPS hub: [VPS hosting](/vps)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fly.io: [Fly.io](/install/fly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hetzner (Docker): [Hetzner](/install/hetzner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- GCP (Compute Engine): [GCP](/install/gcp)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- exe.dev (VM + HTTPS proxy): [exe.dev](/install/exe-dev)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common links（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install guide: [Getting Started](/start/getting-started)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway runbook: [Gateway](/gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway configuration: [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Service status: `openclaw gateway status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway service install (CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use one of these (all supported):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wizard (recommended): `openclaw onboard --install-daemon`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct: `openclaw gateway install`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Configure flow: `openclaw configure` → select **Gateway service**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Repair/migrate: `openclaw doctor` (offers to install or fix the service)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The service target depends on OS:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: LaunchAgent (`bot.molt.gateway` or `bot.molt.<profile>`; legacy `com.openclaw.*`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Linux/WSL2: systemd user service (`openclaw-gateway[-<profile>].service`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
