---
summary: "How the macOS app reports gateway/Baileys health states"
read_when:
  - Debugging mac app health indicators
title: "Health Checks"
x-i18n:
  source_hash: 0560e96501ddf53a499f8960cfcf11c2622fcb9056bfd1bcc57876e955cab03d
---

# macOS의 상태 확인

메뉴바 앱에서 링크된 채널의 정상 여부를 확인하는 방법입니다.

## 메뉴바

- 이제 상태 점이 베일리스의 건강 상태를 반영합니다.
  - 녹색: 연결됨 + 최근에 열린 소켓.
  - 주황색: 연결 중/재시도 중입니다.
  - 빨간색: 로그아웃되었거나 프로브에 실패했습니다.
- 두 번째 줄에는 "linked · auth 12m"이라고 읽거나 실패 이유가 표시됩니다.
- "상태 점검 실행" 메뉴 항목은 주문형 프로브를 트리거합니다.

## 설정

- 일반 탭에는 연결된 인증 기간, 세션 저장소 경로/수, 마지막 확인 시간, 마지막 오류/상태 코드, 상태 확인 실행/로그 표시 버튼 등을 보여주는 상태 카드가 있습니다.
- 캐시된 스냅샷을 사용하여 UI가 즉시 로드되고 오프라인일 때 정상적으로 폴백됩니다.
- **채널 탭**에는 채널 상태 + WhatsApp/Telegram 제어 기능(로그인 QR, 로그아웃, 조사, 마지막 연결 해제/오류)이 표시됩니다.

## 프로브 작동 방식

- 앱은 ~60초마다 요청 시 `openclaw health --json`를 `ShellExecutor`를 통해 실행합니다. 프로브는 메시지를 보내지 않고 자격 증명을 로드하고 상태를 보고합니다.
- 깜박임을 방지하기 위해 마지막으로 좋은 스냅샷과 마지막 오류를 별도로 캐시합니다. 각각의 타임스탬프를 표시합니다.

## 의심스러울 때

- [Gateway health](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) 및 tail `/tmp/openclaw/openclaw-*.log`에서 `web-heartbeat` / `web-reconnect`에 대한 CLI 흐름을 계속 사용할 수 있습니다.
