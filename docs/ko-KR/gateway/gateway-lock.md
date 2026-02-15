---
summary: "Gateway singleton guard using the WebSocket listener bind"
read_when:
  - Running or debugging the gateway process
  - Investigating single-instance enforcement
title: "Gateway Lock"
x-i18n:
  source_hash: 15fdfa066d1925da8b4632073a876709f77ca8d40e6828c174a30d953ba4f8e9
---

# 게이트웨이 잠금

최종 업데이트 날짜: 2025-12-11

## 왜?

- 동일한 호스트의 기본 포트당 하나의 게이트웨이 인스턴스만 실행되도록 합니다. 추가 게이트웨이는 격리된 프로필과 고유한 포트를 사용해야 합니다.
- 오래된 잠금 파일을 남기지 않고 충돌/SIGKILL에서 살아남습니다.
- 제어 포트가 이미 점유되어 있는 경우 명확한 오류로 빠르게 실패합니다.

## 메커니즘

- 게이트웨이는 전용 TCP 리스너를 사용하여 시작 즉시 WebSocket 리스너(기본값 `ws://127.0.0.1:18789`)를 바인딩합니다.
- `EADDRINUSE`로 바인딩이 실패하면 시작 시 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`가 발생합니다.
- OS는 충돌 및 SIGKILL을 포함하여 모든 프로세스 종료 시 자동으로 리스너를 해제합니다. 별도의 잠금 파일이나 정리 단계가 필요하지 않습니다.
- 종료 시 게이트웨이는 WebSocket 서버와 기본 HTTP 서버를 닫아 포트를 즉시 해제합니다.

## 오류 표면

- 다른 프로세스가 포트를 보유하고 있는 경우 시작 시 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`가 발생합니다.
- 기타 바인딩 실패는 `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`로 나타납니다.

## 운영 참고사항

- 포트가 _another_ 프로세스에 의해 점유된 경우 오류는 동일합니다. 포트를 해제하거나 `openclaw gateway --port <port>`를 사용하여 다른 포트를 선택하세요.
- macOS 앱은 게이트웨이를 생성하기 전에 여전히 자체 경량 PID 가드를 유지합니다. 런타임 잠금은 WebSocket 바인드에 의해 시행됩니다.
