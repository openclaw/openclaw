---
summary: "Gateway 대시보드 (Control UI) 액세스 및 인증"
read_when:
  - 대시보드 인증 또는 노출 모드를 변경하는 경우
title: "대시보드"
---

# 대시보드 (Control UI)

Gateway 대시보드는 기본적으로 `/`에서 제공되는 브라우저 Control UI입니다
(`gateway.controlUi.basePath`를 사용하여 변경 가능).

빠른 열기 (로컬 게이트웨이):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (또는 [http://localhost:18789/](http://localhost:18789/))

핵심 참고 사항:

- [Control UI](/ko-KR/web/control-ui) 사용법과 UI 기능.
- [Tailscale](/ko-KR/gateway/tailscale) Serve/Funnel 자동화.
- [Web surfaces](/ko-KR/web) 바인드 모드 및 보안 노트.

인증은 WebSocket 핸드셰이크 시 `connect.params.auth` (토큰 또는 비밀번호)를 통해 적용됩니다.
[Gateway 설정](/ko-KR/gateway/configuration)에서 `gateway.auth`를 참조하세요.

보안 주의: Control UI는 **관리자 표면**입니다 (채팅, 설정, 실행 승인).
공개하지 마세요. UI는 처음 로드 후 토큰을 `localStorage`에 저장합니다.
localhost, Tailscale Serve, 또는 SSH 터널 사용을 권장합니다.

## 빠른 경로 (권장)

- 온보딩 후, CLI는 대시보드를 자동으로 열고 비토큰화된 링크를 출력합니다.
- 언제든지 다시 열기: `openclaw dashboard` (링크를 복사하고, 가능하면 브라우저를 열며, 헤드리스 상태에서 SSH 힌트를 표시).
- UI에서 인증을 요구할 경우, Control UI 설정에 `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`)에서 토큰을 붙여넣으세요.

## 토큰 기본 사항 (로컬 대 원격)

- **Localhost**: `http://127.0.0.1:18789/`를 엽니다.
- **토큰 출처**: `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`); 연결한 후 UI는 복사본을 localStorage에 저장합니다.
- **Not localhost**: Tailscale Serve 사용 (Control UI/WebSocket에 대해 `gateway.auth.allowTailscale: true`이면 토큰 없음, 신뢰할 수 있는 게이트웨이 호스트 가정; HTTP API는 여전히 토큰/비밀번호 필요), 토큰 포함 tailnet 바인드 또는 SSH 터널. [Web surfaces](/ko-KR/web) 참조.

## "unauthorized" / 1008 표시될 경우

- 게이트웨이에 연결 가능한지 확인하세요 (로컬: `openclaw status`; 원격: SSH 터널 `ssh -N -L 18789:127.0.0.1:18789 user@host` 그런 다음 `http://127.0.0.1:18789/` 열기).
- 게이트웨이 호스트에서 토큰 가져오기: `openclaw config get gateway.auth.token` (또는 하나 생성: `openclaw doctor --generate-gateway-token`).
- 대시보드 설정에서 인증 필드에 토큰을 붙여넣은 후 연결하세요.
