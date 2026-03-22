---
summary: "WebSocket 리스너 바인드를 사용한 Gateway 싱글톤 가드"
read_when:
  - Gateway 프로세스를 실행하거나 디버깅할 때
  - 단일 인스턴스 강제를 조사할 때
title: "Gateway 잠금"
x-i18n:
  source_path: docs/gateway/gateway-lock.md
---

# Gateway 잠금

최종 업데이트: 2025-12-11

## 이유

- 동일 호스트에서 기본 포트당 하나의 Gateway 인스턴스만 실행되도록 보장합니다. 추가 Gateway는 격리된 프로필과 고유 포트를 사용해야 합니다.
- 크래시/SIGKILL 후에도 오래된 잠금 파일을 남기지 않습니다.
- 컨트롤 포트가 이미 사용 중일 때 명확한 오류와 함께 즉시 실패합니다.

## 메커니즘

- Gateway는 시작 시 배타적 TCP 리스너를 사용하여 WebSocket 리스너(기본값 `ws://127.0.0.1:18789`)를 즉시 바인딩합니다.
- 바인드가 `EADDRINUSE`로 실패하면, 시작 시 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`를 발생시킵니다.
- OS는 크래시와 SIGKILL을 포함한 모든 프로세스 종료 시 자동으로 리스너를 해제합니다. 별도의 잠금 파일이나 정리 단계가 필요하지 않습니다.
- 종료 시 Gateway는 WebSocket 서버와 기본 HTTP 서버를 닫아 포트를 즉시 해제합니다.

## 오류 표면

- 다른 프로세스가 포트를 보유하고 있으면, 시작 시 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`를 발생시킵니다.
- 다른 바인드 실패는 `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: ...")`로 표시됩니다.

## 운영 참고 사항

- 포트가 _다른_ 프로세스에 의해 점유된 경우, 오류는 동일합니다. 포트를 해제하거나 `openclaw gateway --port <port>`로 다른 포트를 선택하세요.
- macOS 앱은 Gateway를 생성하기 전에 여전히 자체 경량 PID 가드를 유지합니다. 런타임 잠금은 WebSocket 바인드에 의해 강제됩니다.
