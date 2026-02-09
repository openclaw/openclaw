---
summary: "Gateway 대시보드를 위한 통합 Tailscale Serve/Funnel"
read_when:
  - localhost 외부로 Gateway Control UI 노출
  - tailnet 또는 공개 대시보드 접근 자동화
title: "Tailscale"
---

# Tailscale (Gateway 대시보드)

OpenClaw 는 Gateway 대시보드와 WebSocket 포트를 위해 Tailscale **Serve** (tailnet) 또는 **Funnel** (공개) 을 자동으로 구성할 수 있습니다. 이를 통해 Gateway 는 loopback 에 바인딩된 상태를 유지하고, Tailscale 이 HTTPS, 라우팅, 그리고 (Serve 의 경우) 아이덴티티 헤더를 제공합니다.

## 모드

- `serve`: `tailscale serve` 를 통한 tailnet 전용 Serve. 게이트웨이는 `127.0.0.1` 에 유지됩니다.
- `funnel`: `tailscale funnel` 를 통한 공개 HTTPS. OpenClaw 는 공유 비밀번호를 요구합니다.
- `off`: 기본값 (Tailscale 자동화 없음).

## 인증

핸드셰이크를 제어하려면 `gateway.auth.mode` 을 설정합니다:

- `token` (`OPENCLAW_GATEWAY_TOKEN` 가 설정된 경우 기본값)
- `password` (`OPENCLAW_GATEWAY_PASSWORD` 또는 설정을 통한 공유 시크릿)

`tailscale.mode = "serve"` 이고 `gateway.auth.allowTailscale` 이 `true` 인 경우,
유효한 Serve 프록시 요청은 토큰/비밀번호를 제공하지 않고도 Tailscale 아이덴티티 헤더
(`tailscale-user-login`) 를 통해 인증할 수 있습니다. OpenClaw 는 로컬 Tailscale
데몬 (`tailscale whois`) 을 통해 `x-forwarded-for` 주소를 해석하고,
이를 헤더와 매칭하여 수락 여부를 판단함으로써 아이덴티티를 검증합니다.
OpenClaw 는 요청이 loopback 에서 도착하고 Tailscale 의 `x-forwarded-for`,
`x-forwarded-proto`, `x-forwarded-host` 헤더를 포함하는 경우에만 Serve 로 처리합니다.
명시적 자격 증명을 요구하려면 `gateway.auth.allowTailscale: false` 를 설정하거나
`gateway.auth.mode: "password"` 를 강제하십시오.

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

열기: `https://<magicdns>/` (또는 구성된 `gateway.controlUi.basePath`)

### Tailnet 전용 (Tailnet IP 에 바인딩)

Gateway 가 Tailnet IP 에 직접 리슨하도록 하려는 경우 (Serve/Funnel 없음) 에 사용하십시오.

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

참고: 이 모드에서는 loopback (`http://127.0.0.1:18789`) 이 **동작하지 않습니다**.

### 공개 인터넷 (Funnel + 공유 비밀번호)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

디스크에 비밀번호를 커밋하는 것보다 `OPENCLAW_GATEWAY_PASSWORD` 사용을 권장합니다.

## CLI 예시

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## 참고

- Tailscale Serve/Funnel 은 `tailscale` CLI 가 설치되고 로그인되어 있어야 합니다.
- `tailscale.mode: "funnel"` 는 공개 노출을 방지하기 위해 인증 모드가 `password` 가 아니면 시작을 거부합니다.
- 종료 시 OpenClaw 가 `tailscale serve` 또는 `tailscale funnel` 구성을 되돌리도록 하려면 `gateway.tailscale.resetOnExit` 를 설정하십시오.
- `gateway.bind: "tailnet"` 는 직접 Tailnet 바인딩입니다 (HTTPS 없음, Serve/Funnel 없음).
- `gateway.bind: "auto"` 는 loopback 을 선호합니다; Tailnet 전용을 원하면 `tailnet` 을 사용하십시오.
- Serve/Funnel 은 **Gateway 제어 UI + WS** 만 노출합니다. 노드는 동일한 Gateway WS 엔드포인트를 통해 연결되므로, Serve 는 노드 접근에도 동작할 수 있습니다.

## 브라우저 제어 (원격 Gateway + 로컬 브라우저)

Gateway 를 한 머신에서 실행하면서 다른 머신의 브라우저를 제어하려면,
브라우저 머신에서 **노드 호스트** 를 실행하고 두 머신을 동일한 tailnet 에 유지하십시오.
Gateway 는 브라우저 동작을 노드로 프록시합니다; 별도의 제어 서버나 Serve URL 은 필요하지 않습니다.

브라우저 제어에는 Funnel 을 피하고, 노드 페어링을 운영자 접근과 동일하게 취급하십시오.

## Tailscale 사전 요구 사항 + 제한

- Serve 는 tailnet 에 HTTPS 가 활성화되어 있어야 하며, 누락된 경우 CLI 가 안내합니다.
- Serve 는 Tailscale 아이덴티티 헤더를 주입하지만, Funnel 은 그렇지 않습니다.
- Funnel 은 Tailscale v1.38.3+, MagicDNS, HTTPS 활성화, 그리고 funnel 노드 속성이 필요합니다.
- Funnel 은 TLS 상에서 `443`, `8443`, `10000` 포트만 지원합니다.
- macOS 에서 Funnel 을 사용하려면 오픈 소스 Tailscale 앱 변형이 필요합니다.

## 더 알아보기

- Tailscale Serve 개요: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` 명령: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel 개요: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` 명령: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
