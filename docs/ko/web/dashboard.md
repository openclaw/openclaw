---
summary: "Gateway(게이트웨이) 대시보드(Control UI) 접근 및 인증"
read_when:
  - 대시보드 인증 또는 노출 모드를 변경할 때
title: "대시보드"
---

# 대시보드(Control UI)

Gateway(게이트웨이) 대시보드는 기본적으로 `/` 에서 제공되는 브라우저 Control UI 입니다
(`gateway.controlUi.basePath` 로 재정의할 수 있습니다).

빠르게 열기(로컬 Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (또는 [http://localhost:18789/](http://localhost:18789/))

주요 참고 자료:

- 사용법과 UI 기능은 [Control UI](/web/control-ui) 를 참고하십시오.
- Serve/Funnel 자동화는 [Tailscale](/gateway/tailscale) 를 참고하십시오.
- 바인드 모드와 보안 유의 사항은 [Web surfaces](/web) 를 참고하십시오.

인증은 WebSocket 핸드셰이크 단계에서 `connect.params.auth` (토큰 또는 비밀번호)로 강제됩니다. 자세한 내용은 [Gateway 구성](/gateway/configuration)의 `gateway.auth` 를 참고하십시오.

보안 참고: Control UI 는 **관리자 표면**(채팅, 구성, 실행 승인)입니다.
공개적으로 노출하지 마십시오. UI 는 최초 로드 후 토큰을 `localStorage` 에 저장합니다.
localhost, Tailscale Serve, 또는 SSH 터널 사용을 권장합니다.

## 빠른 경로(권장)

- 온보딩 후 CLI 가 대시보드를 자동으로 열고 깨끗한(토큰이 포함되지 않은) 링크를 출력합니다.
- 언제든지 다시 열기: `openclaw dashboard` (링크를 복사하고, 가능하면 브라우저를 열며, 헤드리스 환경에서는 SSH 힌트를 표시합니다).
- UI 에서 인증을 요청하면 `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`)의 토큰을 Control UI 설정에 붙여넣으십시오.

## 토큰 기본 사항(로컬 vs 원격)

- **Localhost**: `http://127.0.0.1:18789/` 를 여십시오.
- **토큰 출처**: `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`); 연결 후 UI 는 localStorage 에 사본을 저장합니다.
- **Localhost 가 아님**: Tailscale Serve(`gateway.auth.allowTailscale: true` 인 경우 토큰 불필요), 토큰을 사용하는 tailnet 바인드, 또는 SSH 터널을 사용하십시오. [Web surfaces](/web) 를 참고하십시오.

## “unauthorized” / 1008 이 표시되는 경우

- 게이트웨이에 도달 가능한지 확인하십시오(로컬: `openclaw status`; 원격: SSH 터널 `ssh -N -L 18789:127.0.0.1:18789 user@host` 후 `http://127.0.0.1:18789/` 열기).
- 게이트웨이 호스트에서 토큰을 가져오십시오: `openclaw config get gateway.auth.token` (또는 새로 생성: `openclaw doctor --generate-gateway-token`).
- 대시보드 설정에서 인증 필드에 토큰을 붙여넣은 다음 연결하십시오.
