---
summary: "외부 CLI (signal-cli, 레거시 imsg)를 위한 RPC 어댑터와 Gateway(게이트웨이) 패턴"
read_when:
  - 외부 CLI 통합을 추가하거나 변경할 때
  - RPC 어댑터 (signal-cli, imsg)를 디버깅할 때
title: "RPC 어댑터"
---

# RPC 어댑터

OpenClaw 는 JSON-RPC 를 통해 외부 CLI 를 통합합니다. 현재 두 가지 패턴이 사용됩니다.

## 패턴 A: HTTP 데몬 (signal-cli)

- `signal-cli` 는 HTTP 상의 JSON-RPC 로 데몬으로 실행됩니다.
- 이벤트 스트림은 SSE (`/api/v1/events`) 입니다.
- 상태 점검 프로브: `/api/v1/check`.
- `channels.signal.autoStart=true` 인 경우 OpenClaw 가 라이프사이클을 소유합니다.

설정 및 엔드포인트는 [Signal](/channels/signal) 을 참고하십시오.

## 패턴 B: stdio 자식 프로세스 (레거시: imsg)

> **참고:** 새로운 iMessage 설정에는 대신 [BlueBubbles](/channels/bluebubbles) 를 사용하십시오.

- OpenClaw 는 `imsg rpc` 를 자식 프로세스로 생성합니다 (레거시 iMessage 통합).
- JSON-RPC 는 stdin/stdout 을 통해 라인 구분 방식으로 전송됩니다 (한 줄당 하나의 JSON 객체).
- TCP 포트가 없으며 데몬이 필요하지 않습니다.

사용되는 핵심 메서드:

- `watch.subscribe` → 알림 (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (프로브/진단)

레거시 설정 및 주소 지정은 [iMessage](/channels/imessage) 를 참고하십시오 (`chat_id` 권장).

## 어댑터 가이드라인

- Gateway(게이트웨이) 가 프로세스를 소유합니다 (시작/중지는 프로바이더 라이프사이클에 연동).
- RPC 클라이언트의 복원력을 유지하십시오: 타임아웃, 종료 시 재시작.
- 표시 문자열보다 안정적인 ID (예: `chat_id`) 를 선호하십시오.
