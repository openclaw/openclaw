---
read_when:
    - OS 지원 또는 설치 경로 찾기
    - 게이트웨이를 실행할 위치 결정
summary: 플랫폼 지원 개요(게이트웨이 + 컴패니언 앱)
title: 플랫폼
x-i18n:
    generated_at: "2026-02-08T16:04:18Z"
    model: gtx
    provider: google-translate
    source_hash: 959479995f9ecca37c91902439dd92311dc2c112c1dec76abfff7741fee67518
    source_path: platforms/index.md
    workflow: 15
---

# 플랫폼

OpenClaw 코어는 TypeScript로 작성되었습니다. **노드는 권장 런타임입니다.**.
Bun은 게이트웨이(WhatsApp/Telegram 버그)에는 권장되지 않습니다.

macOS(메뉴 표시줄 앱) 및 모바일 노드(iOS/Android)용 동반 앱이 존재합니다. 윈도우와
Linux 컴패니언 앱이 계획되어 있지만 게이트웨이는 현재 완벽하게 지원됩니다.
Windows용 기본 동반 앱도 계획되어 있습니다. 게이트웨이는 WSL2를 통해 권장됩니다.

## OS를 선택하세요

- 맥OS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- 기계적 인조 인간: [기계적 인조 인간](/platforms/android)
- 윈도우: [윈도우](/platforms/windows)
- 리눅스: [리눅스](/platforms/linux)

## VPS 및 호스팅

- VPS 허브: [VPS 호스팅](/vps)
- Fly.io: [Fly.io](/install/fly)
- 헤츠너(도커): [헤츠너](/install/hetzner)
- GCP(컴퓨팅 엔진): [GCP](/install/gcp)
- exe.dev(VM + HTTPS 프록시): [exe.dev](/install/exe-dev)

## 공통 링크

- 설치 가이드: [시작하기](/start/getting-started)
- 게이트웨이 실행서: [게이트웨이](/gateway)
- 게이트웨이 구성: [구성](/gateway/configuration)
- 서비스 상태: `openclaw gateway status`

## 게이트웨이 서비스 설치(CLI)

다음 중 하나를 사용하십시오(모두 지원됨).

- 마법사(권장): `openclaw onboard --install-daemon`
- 직접: `openclaw gateway install`
- 흐름 구성: `openclaw configure` → 선택 **게이트웨이 서비스**
- 복구/마이그레이션: `openclaw doctor` (서비스 설치 또는 수정 제안)

서비스 대상은 OS에 따라 다릅니다.

- macOS: LaunchAgent(`bot.molt.gateway` 또는 `bot.molt.<profile>`; 유산 `com.openclaw.*`)
- Linux/WSL2: 시스템 사용자 서비스(`openclaw-gateway[-<profile>].service`)
