---
read_when:
    - Tailscale을 통해 게이트웨이에 액세스하려고 합니다.
    - 브라우저 제어 UI 및 구성 편집을 원합니다.
summary: '게이트웨이 웹 표면: 제어 UI, 바인딩 모드 및 보안'
title: 편물
x-i18n:
    generated_at: "2026-02-08T16:16:15Z"
    model: gtx
    provider: google-translate
    source_hash: 1315450b71a799c8525ec147286b933eb0b5fd1268ee1a60ac78e63476475564
    source_path: web/index.md
    workflow: 15
---

# 웹(게이트웨이)

게이트웨이는 소규모 서비스를 제공합니다. **브라우저 제어 UI** (Vite + Lit) 게이트웨이 WebSocket과 동일한 포트에서:

- 기본: `http://<host>:18789/`
- 선택적 접두사: 설정 `gateway.controlUi.basePath` (예: `/openclaw`)

능력이 살아있습니다 [컨트롤 UI](/web/control-ui).
이 페이지에서는 바인드 모드, 보안 및 웹 연결 표면에 중점을 둡니다.

## 웹훅

언제 `hooks.enabled=true`, 게이트웨이는 동일한 HTTP 서버에 작은 웹훅 엔드포인트도 노출합니다.
보다 [게이트웨이 구성](/gateway/configuration) → `hooks` 인증 + 페이로드용.

## 구성(기본 설정)

컨트롤 UI는 **기본적으로 활성화됨** 자산이 있는 경우(`dist/control-ui`).
구성을 통해 제어할 수 있습니다.

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## 테일스케일 접근

### 통합 서브(권장)

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

열려 있는:

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

열려 있는:

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
- 비 루프백 바인드는 여전히 **필요하다** 공유 토큰/비밀번호(`gateway.auth` 또는 환경).
- 마법사는 기본적으로(루프백에서도) 게이트웨이 토큰을 생성합니다.
- UI가 전송합니다. `connect.params.auth.token` 또는 `connect.params.auth.password`.
- Control UI는 클릭재킹 방지 헤더를 보내고 동일한 출처의 브라우저만 허용합니다.
  웹소켓 연결 `gateway.controlUi.allowedOrigins` 설정됩니다.
- Serve를 사용하면 Tailscale ID 헤더가 다음 경우에 인증을 충족할 수 있습니다.
  `gateway.auth.allowTailscale` ~이다 `true` (토큰/비밀번호가 필요하지 않습니다). 세트
  `gateway.auth.allowTailscale: false` 명시적인 자격 증명을 요구합니다. 보다
  [테일스케일](/gateway/tailscale) 그리고 [보안](/gateway/security).
- `gateway.tailscale.mode: "funnel"` 필요하다 `gateway.auth.mode: "password"` (공유 비밀번호).

## UI 구축

게이트웨이는 다음에서 정적 파일을 제공합니다. `dist/control-ui`. 다음을 사용하여 빌드하세요.

```bash
pnpm ui:build # auto-installs UI deps on first run
```
