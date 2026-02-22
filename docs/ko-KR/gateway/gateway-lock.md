---
summary: "WebSocket 리스너 바인딩을 이용한 게이트웨이 싱글톤 보호"
read_when:
  - 게이트웨이 프로세스를 실행하거나 디버깅할 때
  - 단일 인스턴스 강제 적용 방식을 조사할 때
title: "게이트웨이 잠금"
---

# 게이트웨이 잠금 (Gateway Lock)

최종 업데이트: 2025-12-11

## 목적

- 동일한 호스트의 기본 포트당 하나의 게이트웨이 인스턴스만 실행되도록 보장합니다. 추가 게이트웨이는 격리된 프로필과 고유한 포트를 사용해야 합니다.
- 크래시/SIGKILL 이후에도 오래된 잠금 파일을 남기지 않고 정상 동작합니다.
- 제어 포트가 이미 사용 중일 때 명확한 오류와 함께 빠르게 실패합니다.

## 동작 방식

- 게이트웨이는 시작 시 즉시 전용 TCP 리스너를 사용하여 WebSocket 리스너 (기본값 `ws://127.0.0.1:18789`)를 바인딩합니다.
- 바인딩이 `EADDRINUSE`로 실패하면, 시작 시 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`를 발생시킵니다.
- OS는 크래시 및 SIGKILL을 포함한 모든 프로세스 종료 시 리스너를 자동으로 해제합니다. 별도의 잠금 파일이나 정리 단계가 필요하지 않습니다.
- 종료 시 게이트웨이는 포트를 즉시 해제하기 위해 WebSocket 서버와 기반 HTTP 서버를 닫습니다.

## 오류 유형

- 다른 프로세스가 포트를 점유하고 있으면, 시작 시 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`를 발생시킵니다.
- 그 외 바인딩 실패는 `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`로 표시됩니다.

## 운영 참고 사항

- _다른_ 프로세스가 포트를 점유하고 있는 경우 오류 메시지는 동일합니다. 포트를 해제하거나 `openclaw gateway --port <port>`로 다른 포트를 선택하십시오.
- macOS 앱은 게이트웨이를 시작하기 전에 자체적인 경량 PID 보호를 유지합니다. 런타임 잠금은 WebSocket 바인딩으로 강제됩니다.
