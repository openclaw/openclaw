---
summary: "Gateway web surfaces: Control UI, bind modes, and security"
read_when:
  - You want to access the Gateway over Tailscale
  - You want the browser Control UI and config editing
title: "Web"
x-i18n:
  source_hash: 1315450b71a799c8525ec147286b933eb0b5fd1268ee1a60ac78e63476475564
---

# 웹(게이트웨이)

게이트웨이는 게이트웨이 WebSocket과 동일한 포트에서 작은 **브라우저 제어 UI**(Vite + Lit)를 제공합니다.

- 기본값 : `http://<host>:18789/`
- 선택적 접두사: `gateway.controlUi.basePath` 설정(예: `/openclaw`)

기능은 [제어 UI](/web/control-ui)에 있습니다.
이 페이지에서는 바인드 모드, 보안 및 웹 연결 표면에 중점을 둡니다.

## 웹훅

`hooks.enabled=true`인 경우 게이트웨이는 동일한 HTTP 서버에 작은 웹훅 엔드포인트도 노출합니다.
인증 + 페이로드는 [게이트웨이 구성](/gateway/configuration) → `hooks`를 참조하세요.

## 구성(기본값)

컨트롤 UI는 자산이 존재하는 경우 **기본적으로 활성화**됩니다(`dist/control-ui`).
구성을 통해 제어할 수 있습니다.

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## 테일스케일 액세스

### 통합서브(권장)

게이트웨이를 루프백 상태로 유지하고 Tailscale Serve가 이를 프록시하도록 합니다.

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

그런 다음 게이트웨이를 시작합니다.

```bash
openclaw gateway
```

열기:

- `https://<magicdns>/` (또는 구성한 `gateway.controlUi.basePath`)

### 테일넷 바인드 + 토큰

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

그런 다음 게이트웨이를 시작합니다(비루프백 바인드에 필요한 토큰).

```bash
openclaw gateway
```

열기:

- `http://<tailscale-ip>:18789/` (또는 구성한 `gateway.controlUi.basePath`)

### 공용 인터넷(퍼널)

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

- 기본적으로 게이트웨이 인증이 필요합니다(토큰/비밀번호 또는 Tailscale ID 헤더).
- 비 루프백 바인딩에는 여전히 공유 토큰/비밀번호(`gateway.auth` 또는 env)가 **필요**합니다.
- 마법사는 기본적으로(루프백에서도) 게이트웨이 토큰을 생성합니다.
- UI는 `connect.params.auth.token` 또는 `connect.params.auth.password`를 보냅니다.
- Control UI는 클릭재킹 방지 헤더를 보내고 동일한 출처의 브라우저만 허용합니다.
  `gateway.controlUi.allowedOrigins`가 설정되지 않은 경우 websocket 연결.
- Serve를 사용하면 Tailscale ID 헤더가 다음 경우에 인증을 충족할 수 있습니다.
  `gateway.auth.allowTailscale`는 `true`입니다(토큰/비밀번호가 필요하지 않음). 세트
  `gateway.auth.allowTailscale: false` 명시적인 자격 증명을 요구합니다. 참조
  [Tailscale](/gateway/tailscale) 및 [보안](/gateway/security).
- `gateway.tailscale.mode: "funnel"`에는 `gateway.auth.mode: "password"`(공유 비밀번호)가 필요합니다.

## UI 구축

게이트웨이는 `dist/control-ui`의 정적 파일을 제공합니다. 다음을 사용하여 빌드하세요.

```bash
pnpm ui:build # auto-installs UI deps on first run
```
