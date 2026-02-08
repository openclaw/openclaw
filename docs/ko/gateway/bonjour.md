---
read_when:
    - macOS/iOS에서 Bonjour 검색 문제 디버깅
    - mDNS 서비스 유형, TXT 레코드 또는 검색 UX 변경
summary: Bonjour/mDNS 검색 + 디버깅(게이트웨이 비콘, 클라이언트 및 일반적인 오류 모드)
title: 봉쥬르 디스커버리
x-i18n:
    generated_at: "2026-02-08T15:53:34Z"
    model: gtx
    provider: google-translate
    source_hash: 6f1d676ded5a500ca012feebf06c6ae0fcf458b3a9ac570aff1076d69e7117b8
    source_path: gateway/bonjour.md
    workflow: 15
---

# 봉쥬르/mDNS 검색

OpenClaw는 Bonjour(mDNS/DNS‑SD)를 **LAN만의 편리함** 발견하다
활성 게이트웨이(WebSocket 엔드포인트) 최선의 노력을 다한 것이며, **~ 아니다** SSH를 교체하거나
Tailnet 기반 연결.

## Tailscale을 통한 광역 Bonjour(유니캐스트 DNS-SD)

노드와 게이트웨이가 서로 다른 네트워크에 있는 경우 멀티캐스트 mDNS는
경계. 으로 전환하면 동일한 검색 UX를 유지할 수 있습니다. **유니캐스트 DNS-SD**
("Wide‑Area Bonjour")(Tailscale을 통한).

개략적인 단계:

1. 게이트웨이 호스트(Tailnet을 통해 연결 가능)에서 DNS 서버를 실행합니다.
2. 다음에 대한 DNS‑SD 레코드 게시 `_openclaw-gw._tcp` 전용 구역에서
   (예: `openclaw.internal.`).
3. Tailscale 구성 **분할 DNS** 선택한 도메인은 이를 통해 해결됩니다.
   클라이언트용 DNS 서버(iOS 포함)

OpenClaw는 모든 검색 도메인을 지원합니다. `openclaw.internal.` 단지 예일뿐입니다.
iOS/Android 노드는 둘 다 탐색합니다. `local.` 및 구성된 광역 도메인.

### 게이트웨이 구성(권장)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### 일회성 DNS 서버 설정(게이트웨이 호스트)

```bash
openclaw dns setup --apply
```

그러면 CoreDNS가 설치되고 다음과 같이 구성됩니다.

- 게이트웨이의 Tailscale 인터페이스에서만 포트 53을 수신합니다.
- 선택한 도메인을 제공합니다(예: `openclaw.internal.`) 에서 `~/.openclaw/dns/<domain>.db`

tailnet 연결된 시스템에서 유효성을 검사합니다.

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### 테일스케일 DNS 설정

Tailscale 관리 콘솔에서:

- 게이트웨이의 tailnet IP(UDP/TCP 53)를 가리키는 네임서버를 추가합니다.
- 검색 도메인이 해당 이름 서버를 사용하도록 분할 DNS를 추가합니다.

클라이언트가 tailnet DNS를 수락하면 iOS 노드가 탐색할 수 있습니다.
`_openclaw-gw._tcp` 멀티캐스트 없이 검색 도메인에 있습니다.

### 게이트웨이 리스너 보안(권장)

게이트웨이 WS 포트(기본값 `18789`)는 기본적으로 루프백에 바인딩됩니다. LAN/테일넷용
액세스하고, 명시적으로 바인딩하고, 인증을 활성화한 상태로 유지하세요.

tailnet 전용 설정의 경우:

- 세트 `gateway.bind: "tailnet"` ~에 `~/.openclaw/openclaw.json`.
- 게이트웨이를 다시 시작합니다(또는 macOS 메뉴바 앱을 다시 시작합니다).

## 광고하는 것

게이트웨이만 광고합니다. `_openclaw-gw._tcp`.

## 서비스 유형

- `_openclaw-gw._tcp` — 게이트웨이 전송 비콘(macOS/iOS/Android 노드에서 사용)

## TXT 키(비밀 힌트가 아님)

게이트웨이는 UI 흐름을 편리하게 만들기 위해 비밀이 아닌 작은 힌트를 광고합니다.

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (게이트웨이 WS + HTTP)
- `gatewayTls=1` (TLS가 활성화된 경우에만)
- `gatewayTlsSha256=<sha256>` (TLS가 활성화되어 있고 지문이 사용 가능한 경우에만)
- `canvasPort=<port>` (캔버스 호스트가 활성화된 경우에만; 기본값 `18793`)
- `sshPort=<port>` (재정의되지 않은 경우 기본값은 22입니다)
- `transport=gateway`
- `cliPath=<path>` (선택 사항; 실행 가능 파일의 절대 경로 `openclaw` 진입점)
- `tailnetDns=<magicdns>` (Tailnet을 사용할 수 있는 경우 선택적 힌트)

## macOS에서 디버깅

유용한 내장 도구:

- 인스턴스 찾아보기:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- 하나의 인스턴스 해결(교체 `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

검색은 작동하지만 해결에 실패하는 경우 일반적으로 LAN 정책에 부딪히거나
mDNS 리졸버 문제.

## 게이트웨이 로그에서 디버깅

게이트웨이는 롤링 로그 파일을 작성합니다(시작 시 다음과 같이 인쇄됨).
`gateway log file: ...`). 찾아보세요 `bonjour:` 라인, 특히:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## iOS 노드에서 디버깅

iOS 노드는 다음을 사용합니다. `NWBrowser` 발견하다 `_openclaw-gw._tcp`.

로그를 캡처하려면 다음을 수행하십시오.

- 설정 → 게이트웨이 → 고급 → **검색 디버그 로그**
- 설정 → 게이트웨이 → 고급 → **검색 로그** → 재현 → **복사**

로그에는 브라우저 상태 전환 및 결과 집합 변경 사항이 포함됩니다.

## 일반적인 실패 모드

- **Bonjour는 네트워크를 교차하지 않습니다.**: Tailnet 또는 SSH를 사용합니다.
- **멀티캐스트가 차단됨**: 일부 Wi‑Fi 네트워크에서는 mDNS가 비활성화됩니다.
- **절전/인터페이스 이탈**: macOS에서는 일시적으로 mDNS 결과가 삭제될 수 있습니다. 다시 해 보다.
- **찾아보기는 작동하지만 해결에 실패합니다.**: 기계 이름을 단순하게 유지하십시오(이모티콘이나 문자는 피하십시오).
  구두점)을 입력한 다음 게이트웨이를 다시 시작하세요. 서비스 인스턴스 이름은 다음에서 파생됩니다.
  호스트 이름이므로 이름이 지나치게 복잡하면 일부 확인자가 혼동될 수 있습니다.

## 이스케이프된 인스턴스 이름(`\032`)

Bonjour/DNS‑SD는 서비스 인스턴스 이름의 바이트를 십진수로 이스케이프하는 경우가 많습니다. `\DDD`
시퀀스(예: 공백은 `\032`).

- 이는 프로토콜 수준에서는 정상적인 현상입니다.
- UI는 표시를 위해 디코딩되어야 합니다(iOS는 `BonjourEscapes.decode`).

## 비활성화 / 구성

- `OPENCLAW_DISABLE_BONJOUR=1` 광고를 비활성화합니다(기존: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` ~에 `~/.openclaw/openclaw.json` 게이트웨이 바인드 모드를 제어합니다.
- `OPENCLAW_SSH_PORT` TXT에 공지된 SSH 포트를 재정의합니다(기존: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` TXT에 MagicDNS 힌트를 게시합니다(기존: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` 알려진 CLI 경로를 재정의합니다(기존: `OPENCLAW_CLI_PATH`).

## 관련 문서

- 검색 정책 및 전송 선택: [발견](/gateway/discovery)
- 노드 페어링 + 승인: [게이트웨이 페어링](/gateway/pairing)
