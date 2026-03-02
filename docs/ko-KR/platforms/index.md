---
summary: "플랫폼 지원 개요 (Gateway + 동반 앱)"
read_when:
  - OS 지원 또는 설치 경로를 찾을 때
  - Gateway 를 실행할 위치를 결정할 때
title: "플랫폼"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: platforms/index.md
  workflow: 15
---

# 플랫폼

OpenClaw 코어는 TypeScript 로 작성되었습니다. **Node 는 권장되는 런타임입니다**.
Bun 은 Gateway 에 권장되지 않습니다 (WhatsApp/Telegram 버그).

동반 앱은 macOS (메뉴 막대 앱) 및 모바일 노드 (iOS/Android) 에 대해 존재합니다. Windows 및 Linux 동반 앱이 계획되어 있으나 Gateway 는 완전히 지원됩니다. Windows 용 네이티브 동반 앱도 계획되어 있습니다; Gateway 는 WSL2 를 통해 권장됩니다.

## OS 선택

- macOS: [macOS](/ko-KR/platforms/macos)
- iOS: [iOS](/ko-KR/platforms/ios)
- Android: [Android](/ko-KR/platforms/android)
- Windows: [Windows](/ko-KR/platforms/windows)
- Linux: [Linux](/ko-KR/platforms/linux)

## VPS & 호스팅

- VPS 허브: [VPS 호스팅](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS 프록시): [exe.dev](/install/exe-dev)

## 일반적인 링크

- 설치 가이드: [시작하기](/start/getting-started)
- Gateway 실행 가이드: [Gateway](/ko-KR/gateway)
- Gateway 구성: [구성](/ko-KR/gateway/configuration)
- 서비스 상태: `openclaw gateway status`

## Gateway 서비스 설치 (CLI)

다음 중 하나를 사용합니다 (모두 지원됨):

- 마법사 (권장): `openclaw onboard --install-daemon`
- 직접: `openclaw gateway install`
- 구성 흐름: `openclaw configure` → **Gateway 서비스** 선택
- 복구/마이그레이션: `openclaw doctor` (서비스를 설치하거나 수정할 수 있도록 제공)

서비스 대상은 OS 에 따라 다릅니다:

- macOS: LaunchAgent (`ai.openclaw.gateway` 또는 `ai.openclaw.<profile>`; 레거시 `com.openclaw.*`)
- Linux/WSL2: systemd 사용자 서비스 (`openclaw-gateway[-<profile>].service`)
