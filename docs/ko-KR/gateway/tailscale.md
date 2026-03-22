---
summary: "Gateway 대시보드를 위한 통합 Tailscale Serve/Funnel"
read_when:
  - Gateway Control UI를 localhost 외부에 노출할 때
  - tailnet 또는 공개 대시보드 접근을 자동화할 때
title: "Tailscale"
x-i18n:
  source_path: docs/gateway/tailscale.md
---

# Tailscale (Gateway 대시보드)

OpenClaw은 Gateway 대시보드와 WebSocket 포트를 위해 Tailscale **Serve** (tailnet) 또는 **Funnel** (공개)을 자동 설정할 수 있습니다. Gateway를 루프백에 바인딩한 상태에서 Tailscale이 HTTPS, 라우팅, (Serve의 경우) ID 헤더를 제공합니다.

## 모드

- `serve`: `tailscale serve`를 통한 Tailnet 전용 Serve. Gateway는 `127.0.0.1`에 유지됩니다.
- `funnel`: `tailscale funnel`을 통한 공개 HTTPS. OpenClaw은 공유 비밀번호를 요구합니다.
- `off`: 기본값 (Tailscale 자동화 없음).

## 인증

`gateway.auth.mode`를 설정하여 핸드셰이크를 제어합니다:

- `token` (`OPENCLAW_GATEWAY_TOKEN`이 설정된 경우 기본값)
- `password` (`OPENCLAW_GATEWAY_PASSWORD` 또는 설정을 통한 공유 시크릿)

`tailscale.mode = "serve"`이고 `gateway.auth.allowTailscale`이 `true`이면, Control UI/WebSocket 인증은 토큰/비밀번호를 제공하지 않고 Tailscale ID 헤더(`tailscale-user-login`)를 사용할 수 있습니다. OpenClaw은 로컬 Tailscale 데몬 (`tailscale whois`)을 통해 `x-forwarded-for` 주소를 해석하고 헤더와 매칭하여 ID를 검증한 후 수락합니다. OpenClaw은 Tailscale의 `x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host` 헤더와 함께 루프백에서 도착한 경우에만 요청을 Serve로 취급합니다.
HTTP API 엔드포인트 (예: `/v1/*`, `/tools/invoke`, `/api/channels/*`)는 여전히 토큰/비밀번호 인증을 요구합니다.
이 토큰리스 플로우는 Gateway 호스트가 신뢰된다고 가정합니다. 신뢰할 수 없는 로컬 코드가 동일 호스트에서 실행될 수 있으면 `gateway.auth.allowTailscale`을 비활성화하고 대신 토큰/비밀번호 인증을 요구하세요.
명시적 자격 증명을 요구하려면 `gateway.auth.allowTailscale: false`를 설정하거나 `gateway.auth.mode: "password"`를 강제합니다.

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

### Tailnet 전용 (Tailnet IP에 바인드)

Gateway가 Tailnet IP에서 직접 리스닝하도록 하려면 이것을 사용합니다 (Serve/Funnel 없음).

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

참고: 이 모드에서는 루프백 (`http://127.0.0.1:18789`)이 **작동하지 않습니다**.

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

디스크에 비밀번호를 커밋하는 것보다 `OPENCLAW_GATEWAY_PASSWORD`를 선호합니다.

## CLI 예시

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## 참고

- Tailscale Serve/Funnel은 `tailscale` CLI가 설치되고 로그인되어 있어야 합니다.
- `tailscale.mode: "funnel"`은 공개 노출을 방지하기 위해 인증 모드가 `password`가 아니면 시작을 거부합니다.
- 종료 시 OpenClaw이 `tailscale serve` 또는 `tailscale funnel` 설정을 취소하려면 `gateway.tailscale.resetOnExit`를 설정합니다.
- `gateway.bind: "tailnet"`은 직접 Tailnet 바인드입니다 (HTTPS 없음, Serve/Funnel 없음).
- `gateway.bind: "auto"`는 루프백을 선호합니다. Tailnet 전용을 원하면 `tailnet`을 사용합니다.
- Serve/Funnel은 **Gateway 컨트롤 UI + WS**만 노출합니다. 노드는 동일한 Gateway WS 엔드포인트를 통해 연결되므로, Serve는 노드 접근에도 작동할 수 있습니다.

## 브라우저 제어 (원격 Gateway + 로컬 브라우저)

Gateway를 한 머신에서 실행하지만 다른 머신에서 브라우저를 제어하고 싶으면, 브라우저 머신에서 **노드 호스트**를 실행하고 둘 다 같은 tailnet에 유지합니다. Gateway가 노드로 브라우저 액션을 프록시합니다. 별도의 제어 서버나 Serve URL이 필요하지 않습니다.

브라우저 제어에 Funnel을 사용하지 마세요. 노드 페어링을 운영자 접근처럼 취급합니다.

## Tailscale 전제 조건 + 제한

- Serve는 tailnet에서 HTTPS가 활성화되어 있어야 합니다. CLI가 누락된 경우 프롬프트를 표시합니다.
- Serve는 Tailscale ID 헤더를 삽입합니다. Funnel은 삽입하지 않습니다.
- Funnel은 Tailscale v1.38.3+, MagicDNS, HTTPS 활성화, funnel 노드 속성이 필요합니다.
- Funnel은 TLS를 통해 포트 `443`, `8443`, `10000`만 지원합니다.
- macOS에서 Funnel은 오픈 소스 Tailscale 앱 변형이 필요합니다.

## 더 알아보기

- Tailscale Serve 개요: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` 명령: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel 개요: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` 명령: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
