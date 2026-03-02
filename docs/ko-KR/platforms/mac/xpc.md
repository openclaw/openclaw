---
summary: "OpenClaw 앱, gateway 노드 전송, 그리고 PeekabooBridge에 대한 macOS IPC 아키텍처"
read_when:
  - IPC 계약이나 메뉴 바 앱 IPC를 편집할 때
title: "macOS IPC"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/xpc.md"
  workflow: 15
---

# OpenClaw macOS IPC 아키텍처

**현재 모델:** 로컬 Unix 소켓은 **노드 호스트 서비스**를 **macOS 앱**에 연결합니다. exec 승인 + `system.run`을 위해. 디버그 CLI `openclaw-mac`가 검색/연결 확인을 위해 존재합니다. 에이전트 작업은 여전히 Gateway WebSocket 및 `node.invoke`를 통해 흐릅니다. UI 자동화는 PeekabooBridge를 사용합니다.

## 목표

- 모든 TCC-대면 작업 (알림, 화면 기록, 마이크, 음성, AppleScript)을 소유하는 단일 GUI 앱 인스턴스.
- 자동화에 대한 작은 표면: Gateway + 노드 명령어, 그리고 UI 자동화를 위한 PeekabooBridge.
- 예측 가능한 권한: 항상 동일한 서명된 번들 ID, launchd에 의해 시작되므로 TCC 부여가 고착됩니다.

## 작동 방식

### Gateway + 노드 전송

- 앱은 Gateway를 실행합니다 (로컬 모드) 그리고 노드로서 연결합니다.
- 에이전트 작업은 `node.invoke` (예: `system.run`, `system.notify`, `canvas.*`)를 통해 수행됩니다.

### 노드 서비스 + 앱 IPC

- headless 노드 호스트 서비스는 Gateway WebSocket에 연결합니다.
- `system.run` 요청은 로컬 Unix 소켓을 통해 macOS 앱으로 포워드됩니다.
- 앱은 UI 컨텍스트에서 exec를 수행하고, 필요시 프롬프트하며, 출력을 반환합니다.

다이어그램 (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI 자동화)

- UI 자동화는 `bridge.sock`라는 별도의 UNIX 소켓 및 PeekabooBridge JSON 프로토콜을 사용합니다.
- 호스트 우선순위 (클라이언트 측): Peekaboo.app → Claude.app → OpenClaw.app → 로컬 실행.
- 보안: 브리지 호스트는 허용된 TeamID를 필요로 합니다. DEBUG-only 같은-UID escape hatch는 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (Peekaboo convention)에 의해 보호됩니다.
- 참조: [PeekabooBridge 사용법](/platforms/mac/peekaboo) for 자세한 내용.

## 운영 흐름

- 재시작/재빌드: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - 기존 인스턴스를 죽입니다
  - Swift 빌드 + 패키징
  - LaunchAgent를 작성/부트스트랩/kickstart
- 단일 인스턴스: 앱은 동일한 번들 ID를 가진 다른 인스턴스가 실행 중이면 조기에 종료됩니다.

## 경화 참고 사항

- 모든 권한 표면에 대해 TeamID 일치를 필요로 하는 것을 선호합니다.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-only)는 로컬 개발을 위해 같은-UID 호출자를 허용할 수 있습니다.
- 모든 통신은 로컬 전용이며, 네트워크 소켓은 노출되지 않습니다.
- TCC 프롬프트는 GUI 앱 번들에서만 시작합니다. 재빌드 간에 서명된 번들 ID를 안정적으로 유지합니다.
- IPC 경화: 소켓 모드 `0600`, 토큰, peer-UID 확인, HMAC 챌린지/응답, 짧은 TTL.
