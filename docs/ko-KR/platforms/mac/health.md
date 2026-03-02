---
summary: "macOS 앱이 gateway/Baileys 상태를 보고하는 방식"
read_when:
  - mac 앱 헬스 지표를 디버깅할 때
title: "헬스 체크"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/health.md"
  workflow: 15
---

# macOS의 헬스 체크

메뉴 바 앱에서 연결된 채널이 건강한지 확인하는 방법입니다.

## 메뉴 바

- 상태 표시기는 이제 Baileys 헬스를 반영합니다:
  - 녹색: 연결됨 + 소켓이 최근에 열림.
  - 주황색: 연결 중/재시도.
  - 빨강색: 로그아웃됨 또는 프로브 실패.
- 보조 라인은 "linked · auth 12m"을 읽거나 실패 이유를 표시합니다.
- "Run Health Check" 메뉴 항목은 온디맨드 프로브를 트리거합니다.

## 설정

- General 탭은 헬스 카드를 얻습니다: 연결된 auth 나이, 세션 저장소 경로/개수, 마지막 확인 시간, 마지막 오류/상태 코드, 그리고 헬스 체크 실행/로그 공개 버튼.
- 캐시된 스냅샷을 사용하므로 UI는 즉시 로드되고 오프라인 상태에서 정상적으로 폴백합니다.
- **Channels 탭**은 채널 상태 + WhatsApp/Telegram 제어 (QR 로그인, 로그아웃, 프로브, 마지막 연결 해제/오류)를 표시합니다.

## 프로브 작동 방식

- 앱은 ~60초마다 및 요청 시 `openclaw health --json`을 `ShellExecutor`를 통해 실행합니다. 프로브는 자격 증명을 로드하고 메시지를 보내지 않고 상태를 보고합니다.
- 마지막 정상 스냅샷과 마지막 오류를 별도로 캐시하여 깜박임을 방지합니다. 각각의 타임스탬프를 표시합니다.

## 의심스러울 때

- [Gateway health](/gateway/health)의 CLI 흐름 (`openclaw status`, `openclaw status --deep`, `openclaw health --json`)을 여전히 사용할 수 있으며 `/tmp/openclaw/openclaw-*.log`에서 tail하여 `web-heartbeat` / `web-reconnect`를 확인합니다.
