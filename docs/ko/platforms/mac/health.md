---
summary: "macOS 앱이 gateway/Baileys 상태를 어떻게 보고하는지"
read_when:
  - 28. mac 앱 상태 지표 디버깅
title: "29. 상태 점검"
---

# macOS 에서의 상태 확인

메뉴 막대 앱에서 연결된 채널이 정상인지 확인하는 방법입니다.

## 메뉴 막대

- 상태 점이 이제 Baileys 상태를 반영합니다:
  - 초록색: 연결됨 + 소켓이 최근에 열림.
  - 주황색: 연결 중/재시도 중.
  - 빨간색: 로그아웃됨 또는 프로브 실패.
- 보조 줄에는 "linked · auth 12m" 이 표시되거나 실패 사유가 표시됩니다.
- "Run Health Check" 메뉴 항목은 온디맨드 프로브를 트리거합니다.

## 설정

- 일반 탭에 상태 카드가 추가되어 다음을 표시합니다: 연결된 인증 경과 시간, 세션 저장소 경로/개수, 마지막 확인 시간, 마지막 오류/상태 코드, 그리고 Run Health Check / Reveal Logs 버튼.
- UI 가 즉시 로드되도록 캐시된 스냅샷을 사용하며, 오프라인일 때도 자연스럽게 대체 동작합니다.
- **채널 탭**에서는 WhatsApp/Telegram 에 대한 채널 상태와 제어 항목(로그인 QR, 로그아웃, 프로브, 마지막 연결 해제/오류)을 노출합니다.

## 30. 프로브 작동 방식

- 앱은 약 60초마다 그리고 요청 시 `ShellExecutor` 를 통해 `openclaw health --json` 를 실행합니다. 이 프로브는 자격 증명을 로드하고 메시지를 전송하지 않은 채 상태를 보고합니다.
- 깜빡임을 방지하기 위해 마지막으로 정상인 스냅샷과 마지막 오류를 별도로 캐시하고, 각각의 타임스탬프를 표시합니다.

## 확신이 서지 않을 때

- [Gateway health](/gateway/health) 에서 CLI 흐름(`openclaw status`, `openclaw status --deep`, `openclaw health --json`)을 계속 사용할 수 있으며, `web-heartbeat` / `web-reconnect` 을 위해 `/tmp/openclaw/openclaw-*.log` 를 tail 하십시오.
