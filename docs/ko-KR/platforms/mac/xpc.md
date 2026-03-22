---
summary: "OpenClaw 앱, Gateway 노드 전송, PeekabooBridge 를 위한 macOS IPC 아키텍처"
read_when:
  - IPC 계약 또는 메뉴 바 앱 IPC 를 편집할 때
title: "macOS IPC"
x-i18n:
  source_path: docs/platforms/mac/xpc.md
---

# OpenClaw macOS IPC 아키텍처

**현재 모델:** 로컬 Unix 소켓이 **노드 호스트 서비스**를 **macOS 앱**에 연결하여 실행 승인 + `system.run` 을 처리합니다. `openclaw-mac` 디버그 CLI 가 검색/연결 확인용으로 존재합니다; 에이전트 작업은 여전히 Gateway WebSocket 과 `node.invoke` 를 통해 흐릅니다. UI 자동화는 PeekabooBridge 를 사용합니다.

## 목표

- TCC 관련 모든 작업 (알림, 화면 녹화, 마이크, 음성, AppleScript) 을 소유하는 단일 GUI 앱 인스턴스.
- 자동화를 위한 작은 인터페이스: Gateway + 노드 명령, UI 자동화를 위한 PeekabooBridge.
- 예측 가능한 권한: 항상 동일한 서명된 번들 ID, launchd 에 의해 실행되어 TCC 부여가 유지됩니다.

## 작동 방식

### Gateway + 노드 전송

- 앱이 Gateway (로컬 모드) 를 실행하고 노드로 연결합니다.
- 에이전트 작업은 `node.invoke` (예: `system.run`, `system.notify`, `canvas.*`) 를 통해 수행됩니다.

### 노드 서비스 + 앱 IPC

- 헤드리스 노드 호스트 서비스가 Gateway WebSocket 에 연결합니다.
- `system.run` 요청이 로컬 Unix 소켓을 통해 macOS 앱으로 전달됩니다.
- 앱이 UI 컨텍스트에서 실행을 수행하고, 필요시 프롬프트하며, 출력을 반환합니다.

다이어그램 (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI 자동화)

- UI 자동화는 `bridge.sock` 이라는 별도의 UNIX 소켓과 PeekabooBridge JSON 프로토콜을 사용합니다.
- 호스트 선호 순서 (클라이언트 측): Peekaboo.app → Claude.app → OpenClaw.app → 로컬 실행.
- 보안: 브릿지 호스트는 허용된 TeamID 를 요구합니다; DEBUG 전용 same-UID 예외는 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (Peekaboo 관례) 로 보호됩니다.
- 참조: [PeekabooBridge 사용법](/platforms/mac/peekaboo).

## 운영 흐름

- 재시작/재빌드: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - 기존 인스턴스를 종료합니다
  - Swift 빌드 + 패키징
  - LaunchAgent 작성/부트스트랩/킥스타트
- 단일 인스턴스: 동일한 번들 ID 의 다른 인스턴스가 실행 중이면 앱이 조기 종료합니다.

## 보강 참고

- 모든 권한이 있는 인터페이스에 TeamID 일치를 요구하는 것을 선호합니다.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG 전용) 는 로컬 개발을 위해 same-UID 호출자를 허용할 수 있습니다.
- 모든 통신은 로컬 전용으로 유지됩니다; 네트워크 소켓이 노출되지 않습니다.
- TCC 프롬프트는 GUI 앱 번들에서만 발생합니다; 재빌드 간 서명된 번들 ID 를 안정적으로 유지하세요.
- IPC 보강: 소켓 모드 `0600`, 토큰, peer-UID 확인, HMAC 챌린지/응답, 짧은 TTL.
