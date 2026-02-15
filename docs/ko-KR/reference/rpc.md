---
summary: "RPC adapters for external CLIs (signal-cli, legacy imsg) and gateway patterns"
read_when:
  - Adding or changing external CLI integrations
  - Debugging RPC adapters (signal-cli, imsg)
title: "RPC Adapters"
x-i18n:
  source_hash: 06dc6b97184cc704ba4ec4a9af90502f4316bcf717c3f4925676806d8b184c57
---

# RPC 어댑터

OpenClaw는 JSON-RPC를 통해 외부 CLI를 통합합니다. 오늘날에는 두 가지 패턴이 사용됩니다.

## 패턴 A: HTTP 데몬(signal-cli)

- `signal-cli`는 HTTP를 통해 JSON-RPC를 사용하여 데몬으로 실행됩니다.
- 이벤트 스트림은 SSE(`/api/v1/events`)입니다.
- 상태 프로브: `/api/v1/check`.
- OpenClaw는 `channels.signal.autoStart=true`일 때 수명주기를 소유합니다.

설정 및 엔드포인트는 [신호](/channels/signal)를 참조하세요.

## 패턴 B: stdio 하위 프로세스(레거시: imsg)

> **참고:** 새로운 iMessage 설정의 경우 [BlueBubbles](/channels/bluebubbles)를 대신 사용하세요.

- OpenClaw는 `imsg rpc`를 하위 프로세스로 생성합니다(레거시 iMessage 통합).
- JSON-RPC는 stdin/stdout에서 줄로 구분됩니다(줄당 하나의 JSON 개체).
- TCP 포트가 없고 데몬이 필요하지 않습니다.

사용된 핵심 방법:

- `watch.subscribe` → 알림 (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (프로브/진단)

레거시 설정 및 주소 지정은 [iMessage](/channels/imessage)를 참조하세요(`chat_id` 선호).

## 어댑터 지침

- 게이트웨이는 프로세스를 소유합니다(제공자 수명주기에 연결된 시작/중지).
- RPC 클라이언트의 탄력성을 유지합니다: 시간 초과, 종료 시 다시 시작.
- 표시 문자열보다 안정적인 ID(예: `chat_id`)를 선호합니다.
