---
summary: "WebSocket 리스너 바인드를 사용하는 Gateway(게이트웨이) 싱글톤 가드"
read_when:
  - Gateway(게이트웨이) 프로세스를 실행하거나 디버깅할 때
  - 단일 인스턴스 강제를 조사할 때
title: "Gateway(게이트웨이) 잠금"
---

# Gateway(게이트웨이) 잠금

마지막 업데이트: 2025-12-11

## 이유

- 동일한 호스트에서 기본 포트당 하나의 Gateway(게이트웨이) 인스턴스만 실행되도록 보장합니다. 추가 Gateway(게이트웨이)는 격리된 프로필과 고유한 포트를 사용해야 합니다.
- Survive crashes/SIGKILL without leaving stale lock files.
- 제어 포트가 이미 점유된 경우 명확한 오류와 함께 빠르게 실패합니다.

## 메커니즘

- Gateway(게이트웨이)는 시작 시점에 즉시 WebSocket 리스너(기본값 `ws://127.0.0.1:18789`)를 독점 TCP 리스너로 바인드합니다.
- 바인드가 `EADDRINUSE`로 실패하면, 시작 과정에서 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`가 발생합니다.
- OS 는 크래시 및 SIGKILL 을 포함한 모든 프로세스 종료 시 리스너를 자동으로 해제하므로, 별도의 잠금 파일이나 정리 단계가 필요하지 않습니다.
- 종료 시 Gateway(게이트웨이)는 WebSocket 서버와 하위 HTTP 서버를 닫아 포트를 신속하게 해제합니다.

## 오류 표면

- 다른 프로세스가 포트를 점유하고 있으면, 시작 시 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`가 발생합니다.
- 기타 바인드 실패는 `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`로 노출됩니다.

## 운영 참고 사항

- 포트가 _다른_ 프로세스에 의해 점유된 경우에도 오류는 동일합니다. 포트를 해제하거나 `openclaw gateway --port <port>`로 다른 포트를 선택하십시오.
- macOS 앱은 Gateway(게이트웨이)를 스폰하기 전에 자체적인 경량 PID 가드를 여전히 유지합니다. 런타임 잠금은 WebSocket 바인드에 의해 강제됩니다.
