---
summary: "Gateway 웹 인터페이스: Control UI, 바인드 모드, 보안"
read_when:
  - Tailscale을 통해 Gateway에 접근하고 싶을 때
  - 브라우저 Control UI와 설정 편집을 원할 때
title: "Web"
---

# Web (Gateway)

Gateway는 Gateway WebSocket과 동일한 포트에서 소형 **브라우저 Control UI** (Vite + Lit)를 제공합니다:

- 기본값: `http://<host>:18789/`
- 선택적 경로 접두사: `gateway.controlUi.basePath` 설정 (예: `/openclaw`)

기능 목록은 [Control UI](/ko-KR/web/control-ui)를 참고하세요.
이 페이지는 바인드 모드, 보안, 웹 인터페이스에 대해 설명합니다.

## 웹훅

`hooks.enabled=true`로 설정하면 Gateway는 동일한 HTTP 서버에 소형 웹훅 엔드포인트를 추가로 노출합니다.
인증 및 페이로드 관련 내용은 [Gateway 설정](/ko-KR/gateway/configuration) → `hooks` 항목을 참고하세요.

## 설정 (기본 활성화)

Control UI는 에셋이 존재할 경우 (`dist/control-ui`) **기본적으로 활성화**됩니다.
설정으로 제어할 수 있습니다:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath는 선택사항
  },
}
```

## Tailscale 접근

### Integrated Serve 방식 (권장)

Gateway를 루프백에 유지하고 Tailscale Serve로 프록시합니다:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Gateway 시작:

```bash
openclaw gateway
```

접속:

- `https://<magicdns>/` (또는 설정한 `gateway.controlUi.basePath`)

### Tailnet 바인드 + 토큰

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

Gateway 시작 (루프백이 아닌 바인드에는 토큰 필요):

```bash
openclaw gateway
```

접속:

- `http://<tailscale-ip>:18789/` (또는 설정한 `gateway.controlUi.basePath`)

### 공인 인터넷 (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // 또는 OPENCLAW_GATEWAY_PASSWORD 환경변수
  },
}
```

## 보안 참고사항

- Gateway 인증은 기본적으로 필수입니다 (토큰/비밀번호 또는 Tailscale 신원 헤더).
- 루프백이 아닌 바인드는 여전히 공유 토큰/비밀번호가 **필수**입니다 (`gateway.auth` 또는 환경변수).
- 마법사는 기본적으로 Gateway 토큰을 생성합니다 (루프백에서도 마찬가지).
- UI는 `connect.params.auth.token` 또는 `connect.params.auth.password`를 전송합니다.
- Control UI는 클릭재킹 방지 헤더를 전송하며, `gateway.controlUi.allowedOrigins`를 설정하지 않는 한 동일 출처의 브라우저 WebSocket 연결만 허용합니다.
- Serve 방식에서 `gateway.auth.allowTailscale`이 `true`이면 Tailscale 신원 헤더로 Control UI/WebSocket 인증을 통과할 수 있습니다 (토큰/비밀번호 불필요).
  HTTP API 엔드포인트는 여전히 토큰/비밀번호가 필요합니다. 명시적 자격증명을 요구하려면 `gateway.auth.allowTailscale: false`로 설정하세요.
  [Tailscale](/ko-KR/gateway/tailscale) 및 [보안](/ko-KR/gateway/security)을 참고하세요. 이 토큰 없는 흐름은 게이트웨이 호스트가 신뢰할 수 있다고 가정합니다.
- `gateway.tailscale.mode: "funnel"`은 `gateway.auth.mode: "password"` (공유 비밀번호)를 필요로 합니다.

## UI 빌드

Gateway는 `dist/control-ui`에서 정적 파일을 제공합니다. 빌드 명령:

```bash
pnpm ui:build # 첫 실행 시 UI 의존성 자동 설치
```
