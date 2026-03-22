---
summary: "플랫폼 지원 개요 (Gateway + 동반 앱)"
read_when:
  - OS 지원 또는 설치 경로를 찾을 때
  - Gateway 를 어디에서 실행할지 결정할 때
title: "플랫폼"
x-i18n:
  source_path: docs/platforms/index.md
---

# 플랫폼

OpenClaw 코어는 TypeScript 로 작성되었습니다. **Node 가 권장 런타임입니다**.
Bun 은 Gateway 에 권장되지 않습니다 (WhatsApp/Telegram 버그).

macOS (메뉴 바 앱) 및 모바일 노드 (iOS/Android) 용 동반 앱이 있습니다. Windows 와
Linux 동반 앱은 계획 중이지만, Gateway 는 현재 완전히 지원됩니다.
Windows 용 네이티브 동반 앱도 계획 중이며, Gateway 는 WSL2 를 통해 사용하는 것을 권장합니다.

## OS 선택

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS 및 호스팅

- VPS 허브: [VPS 호스팅](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- Azure (Linux VM): [Azure](/install/azure)
- exe.dev (VM + HTTPS 프록시): [exe.dev](/install/exe-dev)

## 주요 링크

- 설치 가이드: [시작하기](/start/getting-started)
- Gateway 운영 가이드: [Gateway](/gateway)
- Gateway 설정: [설정](/gateway/configuration)
- 서비스 상태: `openclaw gateway status`

## Gateway 서비스 설치 (CLI)

다음 중 하나를 사용하세요 (모두 지원됩니다):

- 마법사 (권장): `openclaw onboard --install-daemon`
- 직접 설치: `openclaw gateway install`
- 설정 흐름: `openclaw configure` → **Gateway service** 선택
- 복구/마이그레이션: `openclaw doctor` (서비스 설치 또는 수정을 제안합니다)

서비스 대상은 OS 에 따라 다릅니다:

- macOS: LaunchAgent (`ai.openclaw.gateway` 또는 `ai.openclaw.<profile>`; 레거시 `com.openclaw.*`)
- Linux/WSL2: systemd 사용자 서비스 (`openclaw-gateway[-<profile>].service`)
