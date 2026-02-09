---
summary: "플랫폼 지원 개요 (Gateway + 컴패니언 앱)"
read_when:
  - OS 지원 또는 설치 경로를 찾고 있을 때
  - Gateway 를 어디에서 실행할지 결정할 때
title: "플랫폼"
---

# 플랫폼

OpenClaw 코어는 TypeScript 로 작성되었습니다. **Node 는 권장 런타임입니다**.
Bun 은 Gateway(게이트웨이)에 권장되지 않습니다 (WhatsApp/Telegram 버그).

컴패니언 앱은 macOS (메뉴 막대 앱) 및 모바일 노드 (iOS/Android)용으로 제공됩니다. Windows 및
Linux 컴패니언 앱은 계획 중이지만, Gateway(게이트웨이)는 현재 완전히 지원됩니다.
Windows 용 네이티브 컴패니언 앱도 계획 중이며, Gateway(게이트웨이)는 WSL2 를 통한 사용을 권장합니다.

## OS 선택

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS & 호스팅

- VPS 허브: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS 프록시): [exe.dev](/install/exe-dev)

## 공통 링크

- 설치 가이드: [시작하기](/start/getting-started)
- Gateway(게이트웨이) 런북: [Gateway](/gateway)
- Gateway(게이트웨이) 구성: [구성](/gateway/configuration)
- 서비스 상태: `openclaw gateway status`

## Gateway(게이트웨이) 서비스 설치 (CLI)

다음 중 하나를 사용하십시오 (모두 지원됨):

- 마법사 (권장): `openclaw onboard --install-daemon`
- 직접 설치: `openclaw gateway install`
- 구성 플로우 설정: `openclaw configure` → **Gateway 서비스** 선택
- 복구/마이그레이션: `openclaw doctor` (서비스 설치 또는 수정 제안)

서비스 대상은 OS 에 따라 다릅니다:

- macOS: LaunchAgent (`bot.molt.gateway` 또는 `bot.molt.<profile>`; 레거시 `com.openclaw.*`)
- Linux/WSL2: systemd 사용자 서비스 (`openclaw-gateway[-<profile>].service`)
