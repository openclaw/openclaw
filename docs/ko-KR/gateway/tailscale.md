---
summary: "Gateway 대시보드를 위한 통합 Tailscale Serve/Funnel"
read_when:
  - Gateway 제어 UI를 로컬호스트 외부에 노출할 때
  - tailnet 또는 공용 대시보드 접근을 자동화할 때
title: "Tailscale"
---

# Tailscale (게이트웨이 대시보드)

OpenClaw는 게이트웨이 대시보드와 WebSocket 포트를 위해 Tailscale **Serve**(tailnet) 또는 **Funnel**(공용)을 자동 설정할 수 있습니다. 이를 통해 게이트웨이는 루프백에 바인딩된 상태를 유지하면서 Tailscale이 HTTPS, 라우팅 및 (Serve의 경우) 신원 헤더를 제공합니다.

## 모드

- `serve`: `tailscale serve`를 통한 Tailnet 전용 Serve. 게이트웨이는 `127.0.0.1`에 유지됩니다.
- `funnel`: `tailscale funnel`을 통한 공용 HTTPS. OpenClaw는 공유 비밀번호가 필요합니다.
- `off`: 기본값 (Tailscale 자동화 없음).

## 인증

`gateway.auth.mode`를 설정하여 핸드셰이크를 제어합니다:

- `token` (`OPENCLAW_GATEWAY_TOKEN`이 설정된 경우 기본값)
- `password` (`OPENCLAW_GATEWAY_PASSWORD` 또는 설정을 통한 공유 비밀)

`tailscale.mode = "serve"`이고 `gateway.auth.allowTailscale`이 `true`일 때, Control UI/WebSocket 인증은 토큰/비밀번호를 제공하지 않고도 Tailscale 신원 헤더(`tailscale-user-login`)를 사용할 수 있습니다. OpenClaw는 로컬 Tailscale 데몬(`tailscale whois`)을 통해 `x-forwarded-for` 주소를 조회하고 이를 헤더와 대조하여 신원을 검증한 후 요청을 수락합니다. OpenClaw는 요청이 루프백에서 Tailscale의 `x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host` 헤더와 함께 도착할 때만 이를 Serve로 처리합니다.
HTTP API 엔드포인트 (예: `/v1/*`, `/tools/invoke`, `/api/channels/*`)는 여전히 토큰/비밀번호 인증이 필요합니다.
이 토큰 없는 흐름은 게이트웨이 호스트가 신뢰할 수 있다고 가정합니다. 신뢰할 수 없는 로컬 코드가 동일한 호스트에서 실행될 수 있다면, `gateway.auth.allowTailscale`을 비활성화하고 대신 토큰/비밀번호 인증을 요구하세요.
명시적 자격 증명이 필요하면 `gateway.auth.allowTailscale: false`로 설정하거나 `gateway.auth.mode: "password"`를 강제하세요.

## 설정 예시

### Tailnet 전용 (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

열기: `https://<magicdns>/` (또는 설정된 `gateway.controlUi.basePath`)

### Tailnet 전용 (Tailnet IP에 직접 바인딩)

게이트웨이가 Tailnet IP에서 직접 수신 대기하도록 하려면 (Serve/Funnel 없음) 이를 사용하세요.

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

다른 Tailnet 장치에서 연결:

- 제어 UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

참고: 이 모드에서는 루프백(`http://127.0.0.1:18789`)이 **작동하지 않습니다**.

### 공용 인터넷 (Funnel + 공유 비밀번호)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

비밀번호를 디스크에 저장하는 것보다 `OPENCLAW_GATEWAY_PASSWORD`를 환경 변수로 사용하는 것을 권장합니다.

## CLI 예시

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## 주의사항

- Tailscale Serve/Funnel은 `tailscale` CLI가 설치되어 있고 로그인된 상태여야 합니다.
- `tailscale.mode: "funnel"`은 공개 노출을 방지하기 위해 인증 모드가 `password`가 아니면 시작을 거부합니다.
- 종료 시 OpenClaw가 `tailscale serve` 또는 `tailscale funnel` 설정을 되돌리게 하려면 `gateway.tailscale.resetOnExit`을 설정하세요.
- `gateway.bind: "tailnet"`은 직접 Tailnet 바인딩입니다 (HTTPS 없음, Serve/Funnel 없음).
- `gateway.bind: "auto"`는 루프백을 우선시합니다; Tailnet 전용을 원하면 `tailnet`을 사용하세요.
- Serve/Funnel은 **게이트웨이 제어 UI + WS**만 노출합니다. 노드는 동일한 게이트웨이 WS 엔드포인트를 통해 연결되므로, Serve는 노드 접근에도 사용할 수 있습니다.

## 브라우저 제어 (원격 게이트웨이 + 로컬 브라우저)

한 머신에서 게이트웨이를 실행하고 다른 머신의 브라우저를 제어하고 싶다면, 브라우저가 있는 머신에서 **노드 호스트**를 실행하고 둘 다 동일한 tailnet에 유지하세요. 게이트웨이가 브라우저 동작을 노드에 프록시합니다; 별도의 제어 서버나 Serve URL이 필요하지 않습니다.

브라우저 제어에는 Funnel을 사용하지 마세요; 노드 페어링을 운영자 접근처럼 취급하세요.

## Tailscale 전제 조건 + 제한

- Serve는 tailnet에 HTTPS가 활성화되어 있어야 합니다; 누락된 경우 CLI가 안내합니다.
- Serve는 Tailscale 신원 헤더를 주입합니다; Funnel은 그렇지 않습니다.
- Funnel은 Tailscale v1.38.3+, MagicDNS, HTTPS 활성화 및 funnel 노드 속성이 필요합니다.
- Funnel은 TLS를 통해 포트 `443`, `8443`, `10000`만 지원합니다.
- macOS에서의 Funnel은 오픈소스 Tailscale 앱 변형이 필요합니다.

## 자세히 알아보기

- Tailscale Serve 개요: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` 명령어: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel 개요: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` 명령어: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
