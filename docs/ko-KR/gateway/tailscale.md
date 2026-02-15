---
summary: "Integrated Tailscale Serve/Funnel for the Gateway dashboard"
read_when:
  - Exposing the Gateway Control UI outside localhost
  - Automating tailnet or public dashboard access
title: "Tailscale"
x-i18n:
  source_hash: c4842b10848d4fdd0f2538d8c786185ed029c2c6149b92eefbc6f1f572e8d440
---

# Tailscale(게이트웨이 대시보드)

OpenClaw는 Tailscale **Serve**(tailnet) 또는 **Funnel**(공개)을 자동으로 구성할 수 있습니다.
게이트웨이 대시보드 및 WebSocket 포트. 이렇게 하면 게이트웨이가 루프백에 바인딩된 상태로 유지됩니다.
Tailscale은 HTTPS, 라우팅 및 (Serve용) ID 헤더를 제공합니다.

## 모드

- `serve`: `tailscale serve`를 통한 테일넷 전용 서비스입니다. 게이트웨이는 `127.0.0.1`에 유지됩니다.
- `funnel`: `tailscale funnel`를 통한 공개 HTTPS. OpenClaw에는 공유 비밀번호가 필요합니다.
- `off`: 기본값(Tailscale 자동화 없음).

## 인증

핸드셰이크를 제어하려면 `gateway.auth.mode`을 설정하십시오.

- `token` (`OPENCLAW_GATEWAY_TOKEN`가 설정된 경우 기본값)
- `password` (`OPENCLAW_GATEWAY_PASSWORD` 또는 구성을 통해 공유된 비밀)

`tailscale.mode = "serve"` 및 `gateway.auth.allowTailscale`가 `true`인 경우,
유효한 서비스 프록시 요청은 Tailscale ID 헤더를 통해 인증할 수 있습니다.
(`tailscale-user-login`) 토큰/비밀번호를 제공하지 않고. OpenClaw 검증
로컬 Tailscale을 통해 `x-forwarded-for` 주소를 확인하여 신원 확인
데몬(`tailscale whois`)을 사용하고 이를 수락하기 전에 헤더와 일치시킵니다.
OpenClaw는 요청이 루프백에서 도착할 때만 요청을 Serve로 처리합니다.
Tailscale의 `x-forwarded-for`, `x-forwarded-proto` 및 `x-forwarded-host`
헤더.
명시적인 자격 증명을 요구하려면 `gateway.auth.allowTailscale: false`를 설정하거나
`gateway.auth.mode: "password"`를 강제합니다.

## 구성 예

### 테일넷 전용(서브)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

열기: `https://<magicdns>/` (또는 구성한 `gateway.controlUi.basePath`)

### Tailnet 전용(Tailnet IP에 바인딩)

게이트웨이가 Tailnet IP(서브/퍼널 없음)에서 직접 수신 대기하도록 하려는 경우 이를 사용하십시오.

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
- 웹소켓: `ws://<tailscale-ip>:18789`

참고: 루프백(`http://127.0.0.1:18789`)은 이 모드에서 작동하지 **않습니다**.

### 공용 인터넷(퍼널 + 공유 비밀번호)

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

## CLI 예

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## 메모

- Tailscale Serve/Funnel에는 `tailscale` CLI 설치 및 로그인이 필요합니다.
- `tailscale.mode: "funnel"`는 공개 노출을 피하기 위해 인증 모드가 `password`가 아닌 이상 시작을 거부합니다.
- OpenClaw가 `tailscale serve`를 실행 취소하려면 `gateway.tailscale.resetOnExit`를 설정하세요.
  또는 종료 시 `tailscale funnel` 구성.
- `gateway.bind: "tailnet"`는 직접 Tailnet 바인딩입니다(HTTPS 없음, Serve/Funnel 없음).
- `gateway.bind: "auto"`는 루프백을 선호합니다. Tailnet만 사용하려면 `tailnet`을 사용하세요.
- Serve/Funnel은 **Gateway 제어 UI + WS**만 노출합니다. 노드는 다음을 통해 연결됩니다.
  동일한 Gateway WS 엔드포인트이므로 Serve가 노드 액세스를 위해 작동할 수 있습니다.

## 브라우저 제어(원격 게이트웨이 + 로컬 브라우저)

한 시스템에서 게이트웨이를 실행하지만 다른 시스템에서 브라우저를 구동하려는 경우,
브라우저 시스템에서 **노드 호스트**를 실행하고 둘 다 동일한 tailnet에 유지하십시오.
게이트웨이는 브라우저 작업을 노드로 프록시합니다. 별도의 제어 서버나 서버 URL이 필요하지 않습니다.

브라우저 제어를 위해 유입경로를 피하세요. 노드 쌍을 운영자 액세스처럼 취급합니다.

## Tailscale 전제 조건 + 제한

- 서비스를 이용하려면 tailnet에 HTTPS가 활성화되어 있어야 합니다. 누락된 경우 CLI에서 메시지를 표시합니다.
- Serve는 Tailscale ID 헤더를 삽입합니다. 깔때기는 그렇지 않습니다.
- 퍼널에는 Tailscale v1.38.3+, MagicDNS, HTTPS 활성화 및 퍼널 노드 속성이 필요합니다.
- Funnel은 TLS를 통해 `443`, `8443`, `10000` 포트만 지원합니다.
- macOS의 Funnel에는 오픈 소스 Tailscale 앱 변형이 필요합니다.

## 자세히 알아보기

- Tailscale 서버 개요: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` 명령: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale 유입 경로 개요: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` 명령: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
