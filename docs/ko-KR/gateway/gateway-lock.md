---
summary: "WebSocket 리스너 바인드를 사용한 게이트웨이 싱글톤 가드"
read_when:
  - 게이트웨이 프로세스 실행 또는 디버깅
  - 단일 인스턴스 적용 조사
title: "게이트웨이 잠금"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/gateway-lock.md
  workflow: 15
---

# 게이트웨이 잠금

마지막 업데이트: 2025-12-11

## 이유

- 동일 호스트에서 기본 포트당 하나의 게이트웨이 인스턴스만 실행되도록 보장; 추가 게이트웨이는 고립된 프로파일과 고유 포트를 사용해야 합니다.
- 오래된 잠금 파일을 남기지 않으면서 충돌/SIGKILL에서 생존합니다.
- 제어 포트가 이미 차지하고 있을 때 명확한 오류로 빠르게 실패합니다.

## 메커니즘

- 게이트웨이는 시작 시 WebSocket 리스너(기본값 `ws://127.0.0.1:18789`)를 독점 TCP 리스너를 사용하여 즉시 바인딩합니다.
- 바인드가 `EADDRINUSE`로 실패하면 시작이 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`를 발생시킵니다.
- OS는 충돌 및 SIGKILL을 포함한 모든 프로세스 종료 시 리스너를 자동으로 해제합니다. 별도의 잠금 파일이나 정리 단계가 필요하지 않습니다.
- 종료할 때 게이트웨이는 WebSocket 서버와 기본 HTTP 서버를 닫아 포트를 즉시 해제합니다.

## 오류 표면

- 다른 프로세스가 포트를 보유하고 있으면 시작이 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`를 발생시킵니다.
- 다른 바인드 실패는 `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`로 표시됩니다.

## 운영 참고

- 포트를 점유하는 **다른** 프로세스가 있으면 오류가 같습니다. 포트를 비우거나 `openclaw gateway --port <port>`로 다른 포트를 선택하세요.
- macOS 앱은 게이트웨이를 생성하기 전에 자체 경량 PID 가드를 유지합니다. 런타임 잠금은 WebSocket 바인드에 의해 적용됩니다.
