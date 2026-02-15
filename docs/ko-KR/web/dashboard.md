---
summary: "Gateway dashboard (Control UI) access and auth"
read_when:
  - Changing dashboard authentication or exposure modes
title: "Dashboard"
x-i18n:
  source_hash: e4fc372b72f030f95d6b8b9ec34d3d9dfef30044d3fb18cec43fa62b5834c037
---

# 대시보드(컨트롤 UI)

게이트웨이 대시보드는 기본적으로 `/`에서 제공되는 브라우저 제어 UI입니다.
(`gateway.controlUi.basePath`로 재정의).

빠른 열기(로컬 게이트웨이):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (또는 [http://localhost:18789/](http://localhost:18789/))

주요 참고자료:

- [Control UI](/web/control-ui) 사용법 및 UI 기능을 확인하세요.
- [Tailscale](/gateway/tailscale) 서비스/퍼널 자동화용.
- 바인드 모드 및 보안 노트를 위한 [웹 표면](/web).

`connect.params.auth`를 통해 WebSocket 핸드셰이크에서 인증이 시행됩니다.
(토큰 또는 비밀번호). [게이트웨이 구성](/gateway/configuration)의 `gateway.auth`를 참조하세요.

보안 참고 사항: Control UI는 **관리 화면**(채팅, 구성, 실행 승인)입니다.
공개적으로 노출하지 마세요. UI는 첫 번째 로드 후 `localStorage`에 토큰을 저장합니다.
localhost, Tailscale Serve 또는 SSH 터널을 선호합니다.

## 빠른 경로(권장)

- 온보딩 후 CLI는 대시보드를 자동으로 열고 깨끗한(토큰화되지 않은) 링크를 인쇄합니다.
- 언제든지 다시 열기: `openclaw dashboard` (링크 복사, 가능한 경우 브라우저 열기, 헤드리스인 경우 SSH 힌트 표시).
- UI에 인증하라는 메시지가 표시되면 `gateway.auth.token`(또는 `OPENCLAW_GATEWAY_TOKEN`)의 토큰을 Control UI 설정에 붙여넣습니다.

## 토큰 기본 사항(로컬 및 원격)

- **로컬호스트**: `http://127.0.0.1:18789/`를 엽니다.
- **토큰 소스**: `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`); 연결 후 UI는 localStorage에 복사본을 저장합니다.
- **localhost 아님**: Tailscale Serve(`gateway.auth.allowTailscale: true`인 경우 토큰 없음), 토큰을 사용한 tailnet 바인딩 또는 SSH 터널을 사용합니다. [웹 표면](/web)을 참조하세요.

## '인증되지 않음'이 표시되는 경우 / 1008

- 게이트웨이에 연결할 수 있는지 확인합니다(로컬: `openclaw status`, 원격: SSH 터널 `ssh -N -L 18789:127.0.0.1:18789 user@host` 후 `http://127.0.0.1:18789/` 열기).
- 게이트웨이 호스트에서 토큰을 검색합니다: `openclaw config get gateway.auth.token` (또는 토큰 생성: `openclaw doctor --generate-gateway-token`).
- 대시보드 설정에서 인증 필드에 토큰을 붙여넣은 후 연결하세요.
