---
summary: "게이트웨이 대시보드에 대한 통합 Tailscale Serve/Funnel"
read_when:
  - localhost 외부에서 게이트웨이 Control UI 노출
  - tailnet 또는 공개 대시보드 액세스 자동화
title: "Tailscale"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/tailscale.md
  workflow: 15
---

# Tailscale(게이트웨이 대시보드)

OpenClaw는 게이트웨이 대시보드 및 WebSocket 포트에 대해 **Serve**(tailnet) 또는 **Funnel**(공개)을 자동 구성할 수 있습니다. 게이트웨이를 루프백에 바인딩된 상태로 유지하면서 Tailscale이 HTTPS, 라우팅 및(Serve의 경우) 신원 헤더를 제공합니다.

## 모드

- `serve`: Tailnet만 Serve(`tailscale serve`를 통해). 게이트웨이는 `127.0.0.1`에 남아 있습니다.
- `funnel`: 공개 HTTPS(`tailscale funnel`을 통해). OpenClaw는 공유 암호를 요구합니다.
- `off`: 기본값(Tailscale 자동화 없음).

## 인증

`gateway.auth.mode`를 설정하여 핸드셰이크를 제어합니다:

- `token` (기본값 `OPENCLAW_GATEWAY_TOKEN`이 설정된 경우)
- `password` (공유 시크릿 `OPENCLAW_GATEWAY_PASSWORD` 또는 설정을 통해)

`tailscale.mode = "serve"` 및 `gateway.auth.allowTailscale`이 `true`일 때,
Control UI/WebSocket 인증이 Tailscale 신원 헤더(`tailscale-user-login`)를 토큰/암호 없이 사용할 수 있습니다. OpenClaw는 로컬 Tailscale daemon(`tailscale whois`)을 통해 `x-forwarded-for` 주소를 확인하여 신원을 확인합니다.

OpenClaw는 요청이 루프백에서 도착하고 Tailscale의 `x-forwarded-for`, `x-forwarded-proto` 및 `x-forwarded-host` 헤더를 포함할 때만 Serve 요청으로 취급합니다.

HTTP API 끝점(예: `/v1/*`, `/tools/invoke`, `/api/channels/*`)은 여전히 토큰/암호 인증을 필요로 합니다.

이 토큰리스 흐름은 게이트웨이 호스트가 신뢰할 수 있다고 가정합니다. 신뢰할 수 없는 로컬 코드가 동일 호스트에서 실행될 수 있으면 `gateway.auth.allowTailscale`을 비활성화하고 대신 토큰/암호 인증을 요구합니다.

명시적 자격 증명을 요구하려면 `gateway.auth.allowTailscale: false`를 설정하거나 `gateway.auth.mode: "password"`를 강제 적용합니다.

## 구성 예제

### Tailnet만(Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

열기: `https://<magicdns>/` (또는 구성된 `gateway.controlUi.basePath`)

### Tailnet만(Tailnet IP에 바인드)

Serve/Funnel 없이 게이트웨이를 직접 Tailnet IP에서 수신하려는 경우 사용합니다.

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

다른 Tailnet 디바이스에서 연결:

- Control UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

참고: 루프백(`http://127.0.0.1:18789`)이 이 모드에서 **작동하지 않습니다**.

### 공개 인터넷(Funnel + 공유 암호)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

`OPENCLAW_GATEWAY_PASSWORD`를 디스크에 커밋하는 것보다 사용합니다.

## CLI 예제

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## 참고

- Tailscale Serve/Funnel은 `tailscale` CLI가 설치되고 로그인되어 있어야 합니다.
- `tailscale.mode: "funnel"`이 공개 노출을 피하기 위해 인증 모드가 `password`인 경우에만 시작합니다.
- 종료 시 OpenClaw가 `tailscale serve` 또는 `tailscale funnel` 설정을 실행 취소하도록 하려면 `gateway.tailscale.resetOnExit`를 설정합니다.
- `gateway.bind: "tailnet"`은 직접 Tailnet 바인드입니다(HTTPS 없음, Serve/Funnel 없음).
- `gateway.bind: "auto"`는 루프백을 선호합니다. Tailnet만 원하면 `tailnet`을 사용합니다.
- Serve/Funnel은 **게이트웨이 제어 UI + WS**만 노출합니다. 노드는 동일한 게이트웨이 WS 끝점을 통해 연결되므로 Serve가 노드 액세스에 작동할 수 있습니다.

## 브라우저 제어(원격 게이트웨이 + 로컬 브라우저)

게이트웨이가 한 머신에서 실행되지만 다른 머신에서 브라우저를 구동하고 싶으면 브라우저 머신에서 **노드 호스트**를 실행하고 둘 다 동일한 tailnet에 유지하세요.
게이트웨이가 노드에 브라우저 작업을 프록시합니다. 별도 제어 서버 또는 Serve URL이 필요하지 않습니다.

브라우저 제어에는 Funnel을 피합니다. 노드 페어링을 운영자 액세스처럼 취급합니다.

## Tailscale 필수 구성 + 제한

- Serve는 tailnet에 HTTPS가 활성화되어 있어야 합니다. CLI가 누락된 경우 프롬프트 표시합니다.
- Serve는 Tailscale 신원 헤더를 주입합니다. Funnel은 하지 않습니다.
- Funnel은 Tailscale v1.38.3+, MagicDNS, HTTPS 활성화 및 funnel 노드 속성이 필요합니다.
- Funnel은 TLS를 통해 `443`, `8443` 및 `10000` 포트만 지원합니다.
- macOS의 Funnel은 오픈 소스 Tailscale app 변형이 필요합니다.

## 자세한 정보

- Tailscale Serve 개요: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` 명령: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel 개요: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` 명령: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
