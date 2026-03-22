---
summary: "Gateway, 노드, 캔버스 호스트가 연결되는 방식"
read_when:
  - Gateway 네트워킹 모델의 간결한 뷰가 필요할 때
title: "네트워크 모델"
x-i18n:
  source_path: docs/gateway/network-model.md
---

# 네트워크 모델

대부분의 작업은 Gateway (`openclaw gateway`)를 통해 흐릅니다. Gateway는 채널 연결과 WebSocket 컨트롤 플레인을 소유하는 단일 장기 실행 프로세스입니다.

## 핵심 규칙

- 호스트당 하나의 Gateway가 권장됩니다. WhatsApp Web 세션을 소유할 수 있는 유일한 프로세스입니다. 복구 봇이나 엄격한 격리를 위해 격리된 프로필과 포트로 여러 Gateway를 실행할 수 있습니다. [여러 Gateway](/gateway/multiple-gateways)를 참고하세요.
- 루프백 우선: Gateway WS는 기본적으로 `ws://127.0.0.1:18789`입니다. 마법사는 루프백에서도 기본적으로 Gateway 토큰을 생성합니다. tailnet 접근의 경우, 비 루프백 바인드에는 토큰이 필요하므로 `openclaw gateway --bind tailnet --token ...`을 실행합니다.
- 노드는 필요에 따라 LAN, tailnet 또는 SSH를 통해 Gateway WS에 연결합니다. 레거시 TCP 브릿지는 더 이상 사용되지 않습니다.
- 캔버스 호스트는 Gateway HTTP 서버에서 Gateway와 **동일한 포트** (기본값 `18789`)로 제공됩니다:
  - `/__openclaw__/canvas/`
  - `/__openclaw__/a2ui/`
    `gateway.auth`가 설정되고 Gateway가 루프백 이상으로 바인딩되면, 이 경로들은 Gateway 인증으로 보호됩니다. 노드 클라이언트는 활성 WS 세션에 연결된 노드 범위 기능 URL을 사용합니다. [Gateway 설정](/gateway/configuration) (`canvasHost`, `gateway`)을 참고하세요.
- 원격 사용은 일반적으로 SSH 터널 또는 tailnet VPN입니다. [원격 접근](/gateway/remote) 및 [디스커버리](/gateway/discovery)를 참고하세요.
