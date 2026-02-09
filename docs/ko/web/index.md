---
summary: "Gateway(게이트웨이) 웹 표면: Control UI, 바인드 모드 및 보안"
read_when:
  - Tailscale 을 통해 Gateway(게이트웨이)에 접근하려는 경우
  - 브라우저 Control UI 및 구성 편집이 필요한 경우
title: "웹"
---

# 웹 (Gateway(게이트웨이))

Gateway(게이트웨이)는 Gateway WebSocket 과 동일한 포트에서 작은 **브라우저 Control UI** (Vite + Lit) 를 제공합니다:

- 기본값: `http://<host>:18789/`
- 선택적 접두사: `gateway.controlUi.basePath` 설정 (예: `/openclaw`)

기능은 [Control UI](/web/control-ui)에 있습니다.
이 페이지는 바인드 모드, 보안 및 웹 노출 표면에 중점을 둡니다.

## 웹훅

`hooks.enabled=true` 인 경우, Gateway(게이트웨이)는 동일한 HTTP 서버에서 작은 웹훅 엔드포인트도 노출합니다.
인증 + 페이로드에 대해서는 [Gateway 구성](/gateway/configuration) → `hooks` 을 참고하십시오.

## 구성 (기본 활성화)

Control UI 는 자산이 존재할 때 **기본적으로 활성화** 됩니다 (`dist/control-ui`).
구성을 통해 제어할 수 있습니다:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale 접근

### 통합 Serve (권장)

Gateway(게이트웨이)를 loopback 에 유지하고 Tailscale Serve 로 프록시합니다:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

그런 다음 Gateway(게이트웨이)를 시작합니다:

```bash
openclaw gateway
```

열기:

- `https://<magicdns>/` (또는 구성된 `gateway.controlUi.basePath`)

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

그런 다음 Gateway(게이트웨이)를 시작합니다 (loopback 이 아닌 바인드에는 토큰이 필요합니다):

```bash
openclaw gateway
```

열기:

- `http://<tailscale-ip>:18789/` (또는 구성된 `gateway.controlUi.basePath`)

### 공용 인터넷 (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## 보안 참고 사항

- Gateway(게이트웨이) 인증은 기본적으로 필요합니다 (토큰/비밀번호 또는 Tailscale ID 헤더).
- loopback 이 아닌 바인드는 여전히 **공유 토큰/비밀번호** 가 **필수** 입니다 (`gateway.auth` 또는 환경 변수).
- 마법사는 기본적으로 Gateway(게이트웨이) 토큰을 생성합니다 (loopback 에서도).
- UI 는 `connect.params.auth.token` 또는 `connect.params.auth.password` 를 전송합니다.
- Control UI 는 클릭재킹 방지 헤더를 전송하며, `gateway.controlUi.allowedOrigins` 이 설정되지 않는 한 동일 출처 브라우저 WebSocket 연결만 허용합니다.
- Serve 사용 시, Tailscale ID 헤더는 `gateway.auth.allowTailscale` 이 `true` 인 경우 인증을 충족할 수 있습니다 (토큰/비밀번호 불필요). 명시적 자격 증명을 요구하려면 `gateway.auth.allowTailscale: false` 을 설정하십시오. 자세한 내용은
  [Tailscale](/gateway/tailscale) 및 [보안](/gateway/security) 을 참고하십시오.
- `gateway.tailscale.mode: "funnel"` 는 `gateway.auth.mode: "password"` (공유 비밀번호) 가 필요합니다.

## UI 빌드

Gateway(게이트웨이)는 `dist/control-ui` 에서 정적 파일을 제공합니다. 다음으로 빌드하십시오:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
