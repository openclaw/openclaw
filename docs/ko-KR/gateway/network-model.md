---
summary: "게이트웨이, 노드 및 캔버스 호스트 연결 방식."
read_when:
  - 게이트웨이 네트워킹 모델의 간결한 보기를 원하는 경우
title: "네트워크 모델"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/network-model.md
  workflow: 15
---

# 네트워크 모델

대부분의 작업은 게이트웨이(`openclaw gateway`)를 통해 흐릅니다. 채널 연결과 WebSocket 제어 평면을 소유하는 단일 장시간 실행되는 프로세스입니다.

## 핵심 규칙

- 호스트당 하나의 게이트웨이를 권장합니다. 이것이 WhatsApp Web 세션을 소유할 수 있는 유일한 프로세스입니다. 구조 유지 봇 또는 엄격한 고립의 경우 고립된 프로파일 및 포트로 여러 게이트웨이를 실행합니다. [Multiple gateways](/gateway/multiple-gateways)를 참조하세요.
- 루프백 우선: Gateway WS는 기본적으로 `ws://127.0.0.1:18789`로 바인딩됩니다. tailnet 액세스의 경우 `openclaw gateway --bind tailnet --token ...`을 실행하세요. 토큰은 루프백 외부 바인드에 필요합니다.
- 노드는 LAN, tailnet 또는 필요에 따라 SSH를 통해 게이트웨이 WS에 연결합니다. 레거시 TCP 브리지는 더 이상 사용되지 않습니다.
- 캔버스 호스트는 게이트웨이 HTTP 서버에서 **동일 포트**에서 제공됩니다(기본값 `18789`):
  - `/__openclaw__/canvas/`
  - `/__openclaw__/a2ui/`
    `gateway.auth`가 구성되고 게이트웨이가 루프백 이상으로 바인딩될 때 이 경로는 게이트웨이 인증으로 보호됩니다. 노드 클라이언트는 활성 WS 세션에 연결된 노드 범위 기능 URL을 사용합니다. [Gateway configuration](/gateway/configuration) (`canvasHost`, `gateway`)을 참조하세요.
- 원격 사용은 일반적으로 SSH 터널 또는 tailnet VPN입니다. [Remote access](/gateway/remote) 및 [Discovery](/gateway/discovery)를 참조하세요.
