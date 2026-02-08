---
read_when:
    - IPC 계약 또는 메뉴 표시줄 앱 IPC 편집
summary: OpenClaw 앱, 게이트웨이 노드 전송 및 PeekabooBridge를 위한 macOS IPC 아키텍처
title: 맥OS IPC
x-i18n:
    generated_at: "2026-02-08T16:07:42Z"
    model: gtx
    provider: google-translate
    source_hash: d0211c334a4a59b71afb29dd7b024778172e529fa618985632d3d11d795ced92
    source_path: platforms/mac/xpc.md
    workflow: 15
---

# OpenClaw macOS IPC 아키텍처

**현재 모델:** 로컬 Unix 소켓은 **노드 호스트 서비스** 에 **macOS 앱** 임원 승인을 위해 + `system.run`. 에이 `openclaw-mac` 검색/연결 확인을 위한 디버그 CLI가 존재합니다. 에이전트 작업은 여전히 ​​Gateway WebSocket을 통해 흐르고 `node.invoke`. UI 자동화는 PeekabooBridge를 사용합니다.

## 목표

- 모든 TCC 관련 작업(알림, 화면 녹화, 마이크, 음성, AppleScript)을 소유하는 단일 GUI 앱 인스턴스입니다.
- 자동화를 위한 작은 표면: 게이트웨이 + 노드 명령과 UI 자동화를 위한 PeekabooBridge.
- 예측 가능한 권한: 항상 동일한 서명된 번들 ID, launchd에 의해 시작되므로 TCC가 계속 부여합니다.

## 작동 원리

### 게이트웨이 + 노드 전송

- 앱은 게이트웨이(로컬 모드)를 실행하고 이에 노드로 연결합니다.
- 에이전트 작업은 다음을 통해 수행됩니다. `node.invoke` (예: `system.run`, `system.notify`, `canvas.*`).

### 노드 서비스 + 앱 IPC

- 헤드리스 노드 호스트 서비스는 Gateway WebSocket에 연결됩니다.
- `system.run` 요청은 로컬 Unix 소켓을 통해 macOS 앱으로 전달됩니다.
- 앱은 UI 컨텍스트에서 실행을 수행하고, 필요한 경우 메시지를 표시하고, 출력을 반환합니다.

다이어그램(SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge(UI 자동화)

- UI 자동화는 다음과 같은 별도의 UNIX 소켓을 사용합니다. `bridge.sock` 그리고 PeekabooBridge JSON 프로토콜이 있습니다.
- 호스트 기본 설정 순서(클라이언트 측): Peekaboo.app → Claude.app → OpenClaw.app → 로컬 실행.
- 보안: 브리지 호스트에는 허용된 TeamID가 필요합니다. 디버그 전용 동일한 UID 탈출구는 다음으로 보호됩니다. `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (까꿍 컨벤션).
- 보다: [PeekabooBridge 사용법](/platforms/mac/peekaboo) 자세한 내용은.

## 운영 흐름

- 다시 시작/재구축: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - 기존 인스턴스를 종료합니다.
  - 스위프트 빌드 + 패키지
  - LaunchAgent를 작성/부트스트랩/킥스타트합니다.
- 단일 인스턴스: 동일한 번들 ID를 가진 다른 인스턴스가 실행 중인 경우 앱이 일찍 종료됩니다.

## 경화 노트

- 모든 권한 있는 표면에 대해 TeamID 일치를 요구하는 것을 선호합니다.
- 피카부브릿지: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (디버그 전용) 로컬 개발을 위해 동일한 UID 호출자를 허용할 수 있습니다.
- 모든 통신은 로컬로만 유지됩니다. 네트워크 소켓은 노출되지 않습니다.
- TCC 프롬프트는 GUI 앱 번들에서만 발생합니다. 재빌드 시 서명된 번들 ID를 안정적으로 유지합니다.
- IPC 강화: 소켓 모드 `0600`, 토큰, 피어 UID 확인, HMAC 챌린지/응답, 짧은 TTL.
