---
summary: "macOS 앱이 Gateway/Baileys 상태를 보고하는 방법"
read_when:
  - Mac 앱 상태 표시기를 디버깅할 때
title: "상태 확인 (macOS)"
x-i18n:
  source_path: docs/platforms/mac/health.md
---

# macOS 상태 확인

메뉴 바 앱에서 연결된 채널이 정상인지 확인하는 방법입니다.

## 메뉴 바

- 상태 점이 이제 Baileys 상태를 반영합니다:
  - 녹색: 연결됨 + 소켓이 최근에 열림.
  - 주황색: 연결 중/재시도 중.
  - 빨간색: 로그아웃 또는 프로브 실패.
- 보조 줄에 "linked · auth 12m" 또는 실패 이유가 표시됩니다.
- "상태 확인 실행" 메뉴 항목이 온디맨드 프로브를 트리거합니다.

## 설정

- 일반 탭에 다음을 표시하는 상태 카드가 추가됩니다: 연결된 인증 수명, 세션 저장소 경로/개수, 마지막 확인 시간, 마지막 오류/상태 코드, 상태 확인 실행 / 로그 표시 버튼.
- 캐시된 스냅샷을 사용하여 UI 가 즉시 로드되고 오프라인일 때 우아하게 폴백합니다.
- **채널 탭**에서 WhatsApp/Telegram 의 채널 상태 + 제어 (로그인 QR, 로그아웃, 프로브, 마지막 연결 해제/오류) 를 표시합니다.

## 프로브 작동 방식

- 앱이 약 60 초마다 그리고 온디맨드로 `ShellExecutor` 를 통해 `openclaw health --json` 을 실행합니다. 프로브는 자격 증명을 로드하고 메시지를 보내지 않고 상태를 보고합니다.
- 깜빡임을 방지하기 위해 마지막 정상 스냅샷과 마지막 오류를 별도로 캐시합니다; 각각의 타임스탬프를 표시합니다.

## 확실하지 않을 때

- [Gateway 상태](/gateway/health) 의 CLI 흐름 (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) 을 사용하고 `web-heartbeat` / `web-reconnect` 에 대해 `/tmp/openclaw/openclaw-*.log` 를 tail 할 수 있습니다.
