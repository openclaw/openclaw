---
read_when:
    - 외부 CLI 통합 추가 또는 변경
    - RPC 어댑터 디버깅(signal-cli, imsg)
summary: 외부 CLI(signal-cli, 레거시 imsg) 및 게이트웨이 패턴용 RPC 어댑터
title: RPC 어댑터
x-i18n:
    generated_at: "2026-02-08T16:08:03Z"
    model: gtx
    provider: google-translate
    source_hash: 06dc6b97184cc704ba4ec4a9af90502f4316bcf717c3f4925676806d8b184c57
    source_path: reference/rpc.md
    workflow: 15
---

# RPC 어댑터

OpenClaw는 JSON-RPC를 통해 외부 CLI를 통합합니다. 오늘날에는 두 가지 패턴이 사용됩니다.

## 패턴 A: HTTP 데몬(signal-cli)

- `signal-cli` HTTP를 통해 JSON-RPC를 사용하여 데몬으로 실행됩니다.
- 이벤트 스트림은 SSE(`/api/v1/events`).
- 상태 프로브: `/api/v1/check`.
- OpenClaw는 다음과 같은 경우에 라이프사이클을 소유합니다. `channels.signal.autoStart=true`.

보다 [신호](/channels/signal) 설정 및 엔드포인트용.

## 패턴 B: stdio 하위 프로세스(레거시: imsg)

> **메모:** 새로운 iMessage 설정의 경우 다음을 사용하세요. [블루버블스](/channels/bluebubbles) 대신에.

- OpenClaw가 생성됩니다. `imsg rpc` 하위 프로세스로(레거시 iMessage 통합)
- JSON-RPC는 stdin/stdout에서 줄로 구분됩니다(한 줄에 하나의 JSON 개체).
- TCP 포트가 없고 데몬이 필요하지 않습니다.

사용된 핵심 방법:

- `watch.subscribe` → 알림(`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (프로브/진단)

보다 [아이메시지](/channels/imessage) 레거시 설정 및 주소 지정(`chat_id` 우선의).

## 어댑터 지침

- 게이트웨이는 프로세스(제공자 수명주기에 연결된 시작/중지)를 소유합니다.
- RPC 클라이언트의 탄력성을 유지합니다. 시간 초과, 종료 시 다시 시작.
- 안정적인 ID를 선호합니다(예: `chat_id`) 표시 문자열 위에.
