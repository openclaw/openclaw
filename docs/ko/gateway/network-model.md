---
read_when:
    - 게이트웨이 네트워킹 모델에 대한 간략한 보기를 원합니다.
summary: 게이트웨이, 노드 및 캔버스 호스트가 연결되는 방법.
title: 네트워크 모델
x-i18n:
    generated_at: "2026-02-08T15:54:11Z"
    model: gtx
    provider: google-translate
    source_hash: e3508b884757ef19f425c82e891e2b07e7fd7d985413d569e55ae9b175c91f0f
    source_path: gateway/network-model.md
    workflow: 15
---

대부분의 작업은 게이트웨이(`openclaw gateway`), 단일 장기 실행
채널 연결과 WebSocket 제어 평면을 소유하는 프로세스입니다.

## 핵심 규칙

- 호스트당 하나의 게이트웨이가 권장됩니다. WhatsApp 웹 세션을 소유할 수 있는 유일한 프로세스입니다. 구조 봇 또는 엄격한 격리의 경우 격리된 프로필과 포트를 사용하여 여러 게이트웨이를 실행하세요. 보다 [다중 게이트웨이](/gateway/multiple-gateways).
- 루프백 우선: Gateway WS의 기본값은 다음과 같습니다. `ws://127.0.0.1:18789`. 마법사는 루프백의 경우에도 기본적으로 게이트웨이 토큰을 생성합니다. tailnet 액세스를 위해 다음을 실행하세요. `openclaw gateway --bind tailnet --token ...` 비루프백 바인드에는 토큰이 필요하기 때문입니다.
- 노드는 필요에 따라 LAN, tailnet 또는 SSH를 통해 Gateway WS에 연결됩니다. 레거시 TCP 브리지는 더 이상 사용되지 않습니다.
- 캔버스 호스트는 HTTP 파일 서버입니다. `canvasHost.port` (기본 `18793`) 봉사 `/__openclaw__/canvas/` 노드 WebView의 경우. 보다 [게이트웨이 구성](/gateway/configuration) (`canvasHost`).
- 원격 사용은 일반적으로 SSH 터널 또는 tailnet VPN입니다. 보다 [원격 액세스](/gateway/remote) 그리고 [발견](/gateway/discovery).
