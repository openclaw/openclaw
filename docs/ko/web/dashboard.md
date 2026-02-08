---
read_when:
    - 대시보드 인증 또는 노출 모드 변경
summary: 게이트웨이 대시보드(Control UI) 액세스 및 인증
title: 계기반
x-i18n:
    generated_at: "2026-02-08T16:07:18Z"
    model: gtx
    provider: google-translate
    source_hash: e4fc372b72f030f95d6b8b9ec34d3d9dfef30044d3fb18cec43fa62b5834c037
    source_path: web/dashboard.md
    workflow: 15
---

# 대시보드(컨트롤 UI)

게이트웨이 대시보드는 다음에서 제공되는 브라우저 제어 UI입니다. `/` 기본적으로
(다음으로 재정의 `gateway.controlUi.basePath`).

빠른 열기(로컬 게이트웨이):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (또는 [http://localhost:18789/](http://localhost:18789/))

주요 참고자료:

- [컨트롤 UI](/web/control-ui) 사용법 및 UI 기능을 위해.
- [테일스케일](/gateway/tailscale) 서브/퍼널 자동화를 위한 것입니다.
- [웹 표면](/web) 바인드 모드 및 보안 메모의 경우.

인증은 다음을 통해 WebSocket 핸드셰이크에서 시행됩니다. `connect.params.auth`
(토큰 또는 비밀번호). 보다 `gateway.auth` ~에 [게이트웨이 구성](/gateway/configuration).

보안 참고 사항: Control UI는 **관리 표면** (채팅, 구성, 실행 승인)
공개적으로 노출하지 마세요. UI는 토큰을 다음 위치에 저장합니다. `localStorage` 첫 번째 로드 후.
localhost, Tailscale Serve 또는 SSH 터널을 선호합니다.

## 빠른 경로(권장)

- 온보딩 후 CLI는 대시보드를 자동으로 열고 깨끗한(토큰화되지 않은) 링크를 인쇄합니다.
- 언제든지 재개장: `openclaw dashboard` (링크를 복사하고, 가능한 경우 브라우저를 열고, 헤드가 없는 경우 SSH 힌트를 표시합니다).
- UI에 인증을 묻는 메시지가 표시되면 다음에서 토큰을 붙여넣습니다. `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`)를 컨트롤 UI 설정으로 이동합니다.

## 토큰 기본 사항(로컬 및 원격)

- **로컬호스트**: 열려 있는 `http://127.0.0.1:18789/`.
- **토큰 소스**: `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`); 연결 후 UI는 localStorage에 복사본을 저장합니다.
- **로컬호스트 아님**: Tailscale Serve를 사용합니다(토큰이 없는 경우 `gateway.auth.allowTailscale: true`), 토큰을 사용한 tailnet 바인딩 또는 SSH 터널. 보다 [웹 표면](/web).

## '인증되지 않음'이 표시되는 경우 / 1008

- 게이트웨이에 연결할 수 있는지 확인하세요(로컬: `openclaw status`; 원격: SSH 터널 `ssh -N -L 18789:127.0.0.1:18789 user@host` 그럼 열어봐 `http://127.0.0.1:18789/`).
- 게이트웨이 호스트에서 토큰을 검색합니다. `openclaw config get gateway.auth.token` (또는 생성: `openclaw doctor --generate-gateway-token`).
- 대시보드 설정에서 인증 필드에 토큰을 붙여넣은 다음 연결하세요.
