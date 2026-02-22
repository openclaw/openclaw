---
summary: "외부 CLIs (signal-cli, 레거시 imsg) 및 게이트웨이 패턴용 RPC 어댑터"
read_when:
  - 외부 CLI 통합을 추가하거나 변경하는 경우
  - RPC 어댑터 (signal-cli, imsg) 디버깅
title: "RPC 어댑터"
---

# RPC 어댑터

OpenClaw는 JSON-RPC를 통해 외부 CLI를 통합합니다. 현재 두 가지 패턴이 사용되고 있습니다.

## 패턴 A: HTTP 데몬 (signal-cli)

- `signal-cli`는 JSON-RPC를 이용한 HTTP 데몬으로 실행됩니다.
- 이벤트 스트림은 SSE (`/api/v1/events`) 입니다.
- 상태 검사: `/api/v1/check`.
- `channels.signal.autoStart=true`인 경우 OpenClaw가 라이프사이클을 관리합니다.

설정 및 엔드포인트에 대한 자세한 내용은 [Signal](/channels/signal)을 참조하세요.

## 패턴 B: stdio 자식 프로세스 (레거시: imsg)

> **참고:** 새 iMessage 설정의 경우, [BlueBubbles](/channels/bluebubbles)를 대신 사용하세요.

- OpenClaw는 `imsg rpc`를 자식 프로세스로 실행합니다 (레거시 iMessage 통합).
- JSON-RPC는 stdin/stdout을 통해 줄 단위로 구분됩니다 (각 줄에 하나의 JSON 객체).
- TCP 포트가 필요하지 않으며 데몬도 필요 없습니다.

사용되는 주요 메서드:

- `watch.subscribe` → 알림 (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (검사/진단)

레거시 설정 및 주소 지정(`chat_id` 권장)에 대한 자세한 내용은 [iMessage](/channels/imessage)를 참조하세요.

## 어댑터 가이드라인

- 게이트웨이는 프로세스를 소유합니다 (시작/중지가 프로바이더 라이프사이클에 연결됨).
- RPC 클라이언트를 견고하게 유지하세요: 타임아웃, 종료 시 재시작.
- 표시 문자열보다는 안정적인 ID(예: `chat_id`)를 선호하세요.
