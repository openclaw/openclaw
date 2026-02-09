---
summary: "Gateway(게이트웨이), 노드, 캔버스 호스트가 어떻게 연결되는지 설명합니다."
read_when:
  - Gateway(게이트웨이) 네트워킹 모델을 간결하게 파악하고 싶을 때
title: "네트워크 모델"
---

대부분의 작업은 Gateway(게이트웨이) (`openclaw gateway`)를 통해 흐르며, 이는 채널 연결과 WebSocket 제어 플레인을 소유하는 단일 장기 실행 프로세스입니다.

## 핵심 규칙

- 호스트당 하나의 Gateway(게이트웨이)를 권장합니다. 이는 WhatsApp Web 세션을 소유할 수 있는 유일한 프로세스입니다. 복구 봇이나 엄격한 격리가 필요한 경우, 격리된 프로필과 포트를 사용하여 여러 게이트웨이를 실행하십시오. [Multiple gateways](/gateway/multiple-gateways)를 참고하십시오.
- Loopback 우선: Gateway WS 기본값은 `ws://127.0.0.1:18789`입니다. 마법사는 loopback 에 대해서도 기본적으로 게이트웨이 토큰을 생성합니다. tailnet 접근의 경우, non-loopback 바인드에는 토큰이 필요하므로 `openclaw gateway --bind tailnet --token ...`를 실행하십시오.
- 노드는 필요에 따라 LAN, tailnet, 또는 SSH 를 통해 Gateway WS 에 연결합니다. 레거시 TCP 브리지는 더 이상 사용되지 않습니다.
- 캔버스 호스트는 `canvasHost.port` (기본값 `18793`)에서 동작하는 HTTP 파일 서버로, 노드 WebView 를 위해 `/__openclaw__/canvas/`를 제공합니다. [Gateway configuration](/gateway/configuration) (`canvasHost`)을 참고하십시오.
- 원격 사용은 일반적으로 SSH 터널 또는 tailnet VPN 입니다. [Remote access](/gateway/remote)와 [Discovery](/gateway/discovery)를 참고하십시오.
