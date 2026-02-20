---
summary: "게이트웨이, 노드, 캔버스 호스트가 연결되는 방식."
read_when:
  - 게이트웨이 네트워킹 모델에 대한 간략한 개요가 필요할 때
title: "네트워크 모델"
---

대부분의 작업은 게이트웨이 (`openclaw gateway`)를 통해 흐르며, 이는 채널 연결과 WebSocket 제어 평면을 담당하는 단일 장기 실행 프로세스입니다.

## 핵심 규칙

- 호스트당 하나의 게이트웨이를 권장합니다. 이는 WhatsApp 웹 세션을 소유할 수 있는 유일한 프로세스입니다. 구조 봇 또는 엄격한 격리를 위해서는 격리된 프로필과 포트를 사용하여 여러 게이트웨이를 실행하십시오. [다중 게이트웨이](/ko-KR/gateway/multiple-gateways)를 참조하세요.
- 로컬 루프백 우선: 게이트웨이 WS의 기본값은 `ws://127.0.0.1:18789`입니다. 기본적으로 마법사는 게이트웨이 토큰을 생성하며, 이는 로컬 루프백에도 적용됩니다. Tailnet 액세스를 위해서는 `openclaw gateway --bind tailnet --token ...`을 실행하십시오. 비 루프백 바인딩에는 토큰이 필요합니다.
- 노드는 필요에 따라 LAN, tailnet, 또는 SSH를 통해 게이트웨이 WS에 연결합니다. 레거시 TCP 브리지는 사용 중단되었습니다.
- 캔버스 호스트는 게이트웨이 HTTP 서버에 의해 **동일한 포트**로 서비스됩니다 (기본값 `18789`):
  - `/__openclaw__/canvas/`
  - `/__openclaw__/a2ui/`
    `gateway.auth`가 구성되고 게이트웨이가 루프백을 넘어 바인딩되면, 이러한 경로는 게이트웨이 인증으로 보호됩니다. 노드 클라이언트는 활성 WS 세션에 연결된 노드 범위 캐퍼빌리티 URL을 사용합니다. [게이트웨이 설정](/ko-KR/gateway/configuration) (`canvasHost`, `gateway`)을 참조하세요.
- 원격 사용은 일반적으로 SSH 터널 또는 tailnet VPN입니다. [원격 접속](/ko-KR/gateway/remote) 및 [디바이스 검색](/ko-KR/gateway/discovery)을 참조하세요.
