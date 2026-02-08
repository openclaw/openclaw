---
read_when:
    - 게이트웨이 프로세스 실행 또는 디버깅
    - 단일 인스턴스 시행 조사
summary: WebSocket 수신기 바인드를 사용하는 게이트웨이 싱글톤 가드
title: 게이트웨이 잠금
x-i18n:
    generated_at: "2026-02-08T15:56:44Z"
    model: gtx
    provider: google-translate
    source_hash: 15fdfa066d1925da8b4632073a876709f77ca8d40e6828c174a30d953ba4f8e9
    source_path: gateway/gateway-lock.md
    workflow: 15
---

# 게이트웨이 잠금

최종 업데이트 날짜: 2025-12-11

## 왜

- 동일한 호스트의 기본 포트당 하나의 게이트웨이 인스턴스만 실행되는지 확인하세요. 추가 게이트웨이는 격리된 프로필과 고유한 포트를 사용해야 합니다.
- 오래된 잠금 파일을 남기지 않고 충돌/SIGKILL에서 살아남습니다.
- 제어 포트가 이미 점유되어 있는 경우 명확한 오류로 빠르게 실패합니다.

## 기구

- 게이트웨이는 WebSocket 수신기를 바인딩합니다(기본값 `ws://127.0.0.1:18789`) 독점 TCP 리스너를 사용하여 시작 시 즉시.
- 바인드가 실패하는 경우 `EADDRINUSE`, 시작이 발생합니다. `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- OS는 충돌 및 SIGKILL을 포함하여 모든 프로세스 종료 시 자동으로 리스너를 해제합니다. 별도의 잠금 파일이나 정리 단계가 필요하지 않습니다.
- 종료 시 게이트웨이는 WebSocket 서버와 기본 HTTP 서버를 닫아 포트를 즉시 해제합니다.

## 오류 표면

- 다른 프로세스가 포트를 보유하고 있으면 시작 시 오류가 발생합니다. `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- 다른 바인드 실패는 다음과 같이 나타납니다. `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`.

## 운영 참고사항

- 포트가 점유된 경우 _또 다른_ 프로세스 오류는 동일합니다. 포트를 비우거나 다른 포트를 선택하십시오. `openclaw gateway --port <port>`.
- macOS 앱은 게이트웨이를 생성하기 전에 여전히 자체 경량 PID 가드를 유지합니다. 런타임 잠금은 WebSocket 바인드에 의해 시행됩니다.
