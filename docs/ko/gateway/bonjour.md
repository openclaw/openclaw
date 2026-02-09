---
summary: "Bonjour/mDNS 디바이스 검색 + 디버깅 (Gateway 비콘, 클라이언트, 일반적인 실패 모드)"
read_when:
  - macOS/iOS 에서 Bonjour 디바이스 검색 문제를 디버깅할 때
  - mDNS 서비스 유형, TXT 레코드 또는 디바이스 검색 UX 를 변경할 때
title: "Bonjour 디바이스 검색"
---

# Bonjour / mDNS 디바이스 검색

OpenClaw 는 활성 Gateway(WebSocket 엔드포인트)를 발견하기 위한 **LAN 전용 편의 기능**으로 Bonjour(mDNS / DNS‑SD)를 사용합니다. 이는 best‑effort 방식이며 SSH 또는 Tailnet 기반 연결을 **대체하지 않습니다**.

## Tailscale 상의 광역 Bonjour(Unicast DNS‑SD)

노드와 Gateway 가 서로 다른 네트워크에 있는 경우, 멀티캐스트 mDNS 는 경계를 넘지 못합니다. 이때 Tailscale 위에서 **유니캐스트 DNS‑SD**("Wide‑Area Bonjour")로 전환하면 동일한 디바이스 검색 UX 를 유지할 수 있습니다.

상위 수준 단계:

1. Gateway 호스트에서 DNS 서버를 실행합니다(Tailnet 을 통해 접근 가능해야 합니다).
2. 전용 존 아래에 `_openclaw-gw._tcp` 에 대한 DNS‑SD 레코드를 게시합니다
   (예: `openclaw.internal.`).
3. 선택한 도메인이 해당 DNS 서버를 통해 해석되도록 Tailscale **분할 DNS**를 구성합니다
   (iOS 포함 클라이언트용).

OpenClaw 는 어떤 디바이스 검색 도메인도 지원하며, `openclaw.internal.` 는 단지 예시입니다.
iOS/Android 노드는 `local.` 와 구성한 광역 도메인을 모두 탐색합니다.

### Gateway 구성(권장)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### DNS 서버 1회 설정(Gateway 호스트)

```bash
openclaw dns setup --apply
```

이는 CoreDNS 를 설치하고 다음과 같이 구성합니다:

- Gateway 의 Tailscale 인터페이스에서만 포트 53 을 수신
- `~/.openclaw/dns/<domain>.db` 에서 선택한 도메인(예: `openclaw.internal.`)을 제공

Tailnet 에 연결된 머신에서 검증합니다:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS 설정

Tailscale 관리자 콘솔에서:

- Gateway 의 tailnet IP 를 가리키는 네임서버를 추가합니다(UDP/TCP 53).
- 디바이스 검색 도메인이 해당 네임서버를 사용하도록 분할 DNS 를 추가합니다.

클라이언트가 tailnet DNS 를 수락하면, iOS 노드는 멀티캐스트 없이도
디바이스 검색 도메인에서 `_openclaw-gw._tcp` 를 탐색할 수 있습니다.

### Gateway 리스너 보안(권장)

Gateway WS 포트(기본값 `18789`)는 기본적으로 loopback 에 바인딩됩니다. LAN/tailnet 접근을 위해서는 명시적으로 바인딩하고 인증을 활성화하십시오.

tailnet 전용 설정의 경우:

- `~/.openclaw/openclaw.json` 에서 `gateway.bind: "tailnet"` 을 설정합니다.
- Gateway 를 재시작합니다(또는 macOS 메뉴바 앱을 재시작합니다).

## 광고 주체

`_openclaw-gw._tcp` 를 광고하는 것은 Gateway 만입니다.

## 서비스 유형

- `_openclaw-gw._tcp` — gateway 전송 비콘(macOS/iOS/Android 노드에서 사용).

## TXT 키(비밀이 아닌 힌트)

Gateway 는 UI 흐름을 편리하게 하기 위해 작은 비밀이 아닌 힌트를 광고합니다:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (TLS 가 활성화된 경우에만)
- `gatewayTlsSha256=<sha256>` (TLS 가 활성화되어 있고 지문을 사용할 수 있는 경우에만)
- `canvasPort=<port>` (캔버스 호스트가 활성화된 경우에만; 기본값 `18793`)
- `sshPort=<port>` (재정의되지 않은 경우 기본값은 22)
- `transport=gateway`
- `cliPath=<path>` (선택 사항; 실행 가능한 `openclaw` 엔트리포인트의 절대 경로)
- `tailnetDns=<magicdns>` (Tailnet 을 사용할 수 있을 때의 선택적 힌트)

## macOS 에서의 디버깅

유용한 내장 도구:

- 인스턴스 탐색:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- 단일 인스턴스 해석(`<instance>` 을 교체):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

탐색은 되지만 해석이 실패한다면, 보통 LAN 정책 또는 mDNS 리졸버 문제입니다.

## Gateway 로그에서의 디버깅

Gateway 는 순환 로그 파일을 작성하며, 시작 시
`gateway log file: ...` 로 출력됩니다. 특히 다음과 같은 `bonjour:` 줄을 확인하십시오:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## iOS 노드에서의 디버깅

iOS 노드는 `NWBrowser` 를 사용하여 `_openclaw-gw._tcp` 를 발견합니다.

로그를 캡처하려면:

- 설정 → Gateway → 고급 → **Discovery 디버그 로그**
- 설정 → Gateway → 고급 → **Discovery 로그** → 재현 → **복사**

로그에는 브라우저 상태 전환과 결과 집합 변경이 포함됩니다.

## 일반적인 실패 모드

- **Bonjour 는 네트워크를 넘지 못함**: Tailnet 또는 SSH 를 사용하십시오.
- **멀티캐스트 차단**: 일부 Wi‑Fi 네트워크는 mDNS 를 비활성화합니다.
- **절전 / 인터페이스 변동**: macOS 는 일시적으로 mDNS 결과를 놓칠 수 있습니다. 재시도하십시오.
- **탐색은 되지만 해석이 실패함**: 머신 이름을 단순하게 유지하십시오(이모지나
  문장부호를 피함). 그런 다음 Gateway 를 재시작하십시오. 서비스 인스턴스 이름은
  호스트 이름에서 파생되므로, 지나치게 복잡한 이름은 일부 리졸버를 혼란스럽게 할 수 있습니다.

## 이스케이프된 인스턴스 이름(`\032`)

Bonjour/DNS‑SD 는 종종 서비스 인스턴스 이름의 바이트를 10진수 `\DDD`
시퀀스로 이스케이프합니다(예: 공백은 `\032` 로 변환됨).

- 이는 프로토콜 수준에서 정상입니다.
- UI 는 표시를 위해 디코딩해야 합니다(iOS 는 `BonjourEscapes.decode` 를 사용).

## 비활성화 / 구성

- `OPENCLAW_DISABLE_BONJOUR=1` 은 광고를 비활성화합니다(레거시: `OPENCLAW_DISABLE_BONJOUR`).
- `~/.openclaw/openclaw.json` 의 `gateway.bind` 는 Gateway 바인드 모드를 제어합니다.
- `OPENCLAW_SSH_PORT` 은 TXT 에 광고되는 SSH 포트를 재정의합니다(레거시: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` 는 TXT 에 MagicDNS 힌트를 게시합니다(레거시: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` 은 광고되는 CLI 경로를 재정의합니다(레거시: `OPENCLAW_CLI_PATH`).

## 관련 문서

- 디바이스 검색 정책 및 전송 선택: [Discovery](/gateway/discovery)
- 노드 페어링 + 승인: [Gateway pairing](/gateway/pairing)
