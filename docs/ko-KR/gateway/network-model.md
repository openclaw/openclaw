---
summary: "How the Gateway, nodes, and canvas host connect."
read_when:
  - You want a concise view of the Gateway networking model
title: "Network model"
x-i18n:
  source_hash: e3508b884757ef19f425c82e891e2b07e7fd7d985413d569e55ae9b175c91f0f
---

대부분의 작업은 단일 장기 실행 게이트웨이(`openclaw gateway`)를 통해 진행됩니다.
채널 연결과 WebSocket 제어 평면을 소유하는 프로세스입니다.

## 핵심 규칙

- 호스트당 하나의 게이트웨이를 권장합니다. WhatsApp 웹 세션을 소유할 수 있는 유일한 프로세스입니다. 구조 봇 또는 엄격한 격리의 경우 격리된 프로필과 포트를 사용하여 여러 게이트웨이를 실행하세요. [다중 게이트웨이](/gateway/multiple-gateways)를 참조하세요.
- 루프백 우선: 게이트웨이 WS의 기본값은 `ws://127.0.0.1:18789`입니다. 마법사는 루프백의 경우에도 기본적으로 게이트웨이 토큰을 생성합니다. 비루프백 바인딩에는 토큰이 필요하므로 tailnet 액세스의 경우 `openclaw gateway --bind tailnet --token ...`를 실행합니다.
- 노드는 필요에 따라 LAN, tailnet 또는 SSH를 통해 Gateway WS에 연결됩니다. 레거시 TCP 브리지는 더 이상 사용되지 않습니다.
- 캔버스 호스트는 노드 WebView에 대해 `/__openclaw__/canvas/`를 제공하는 `canvasHost.port`(기본값 `18793`)의 HTTP 파일 서버입니다. [게이트웨이 구성](/gateway/configuration) (`canvasHost`)을 참조하세요.
- 원격 사용은 일반적으로 SSH 터널 또는 tailnet VPN입니다. [원격 액세스](/gateway/remote) 및 [검색](/gateway/discovery)을 참조하세요.
