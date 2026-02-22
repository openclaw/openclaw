---
summary: "플랫폼 지원 개요 (게이트웨이 + 동반 앱)"
read_when:
  - OS 지원이나 설치 경로를 찾고 있을 때
  - 게이트웨이를 어디에서 실행할지 결정할 때
title: "플랫폼"
---

# Platforms

OpenClaw 핵심은 TypeScript로 작성되었습니다. **Node는 권장 실행 환경입니다**.
게이트웨이에서는 Bun 이 권장되지 않습니다 (WhatsApp/Telegram 버그).

동반 앱은 macOS (메뉴 바 앱)와 모바일 노드 (iOS/Android)용으로 존재합니다. Windows 및 Linux 동반 앱도 계획 중이지만, 게이트웨이는 오늘날에 완전 지원됩니다.
Windows용 기본 동반 앱도 계획 중이며, 게이트웨이는 WSL2를 통해 권장됩니다.

## Choose your OS

- macOS: [macOS](/ko-KR/platforms/macos)
- iOS: [iOS](/ko-KR/platforms/ios)
- Android: [Android](/ko-KR/platforms/android)
- Windows: [Windows](/ko-KR/platforms/windows)
- Linux: [Linux](/ko-KR/platforms/linux)

## VPS & hosting

- VPS hub: [VPS hosting](/ko-KR/vps)
- Fly.io: [Fly.io](/ko-KR/install/fly)
- Hetzner (Docker): [Hetzner](/ko-KR/install/hetzner)
- GCP (Compute Engine): [GCP](/ko-KR/install/gcp)
- exe.dev (VM + HTTPS proxy): [exe.dev](/ko-KR/install/exe-dev)

## Common links

- Install guide: [Getting Started](/ko-KR/start/getting-started)
- Gateway runbook: [Gateway](/ko-KR/gateway)
- Gateway configuration: [Configuration](/ko-KR/gateway/configuration)
- Service status: `openclaw gateway status`

## Gateway service install (CLI)

Use one of these (all supported):

- Wizard (recommended): `openclaw onboard --install-daemon`
- Direct: `openclaw gateway install`
- Configure flow: `openclaw configure` → select **Gateway service**
- Repair/migrate: `openclaw doctor` (offers to install or fix the service)

The service target depends on OS:

- macOS: LaunchAgent (`bot.molt.gateway` 또는 `bot.molt.<profile>`; 기존 `com.openclaw.*`)
- Linux/WSL2: systemd user service (`openclaw-gateway[-<profile>].service`)