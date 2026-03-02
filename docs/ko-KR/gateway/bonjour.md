---
summary: "Bonjour/mDNS 검색 + 디버깅 (게이트웨이 비콘, 클라이언트 및 일반적인 오류 모드)"
read_when:
  - macOS/iOS에서 Bonjour 검색 문제 디버깅
  - mDNS 서비스 유형, TXT 레코드 또는 검색 UX 변경
title: "Bonjour 검색"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/bonjour.md
  workflow: 15
---

# Bonjour / mDNS 검색

OpenClaw는 Bonjour(mDNS / DNS‑SD)를 **LAN 전용 편의**로 사용하여 활성 Gateway(WebSocket 끝점)를 검색합니다. 최선의 노력이며 SSH 또는 Tailnet 기반 연결을 **대체하지 않습니다**.

## Tailscale을 통한 광역 Bonjour(유니캐스트 DNS‑SD)

노드와 게이트웨이가 다른 네트워크에 있는 경우 멀티캐스트 mDNS는 경계를 넘지 못합니다. **유니캐스트 DNS‑SD**("광역 Bonjour")를 Tailscale을 통해 사용하여 동일한 검색 UX를 유지할 수 있습니다.

높은 수준의 단계:

1. 게이트웨이 호스트에서 DNS 서버 실행(Tailnet을 통해 연결 가능).
2. 전용 영역(예: `openclaw.internal.`)에서 `_openclaw-gw._tcp`에 대한 DNS‑SD 레코드 게시.
3. Tailscale **분할 DNS**를 구성하여 선택한 도메인이 클라이언트(iOS 포함)의 DNS 서버를 통해 확인되도록 합니다.

OpenClaw는 모든 검색 도메인을 지원합니다. `openclaw.internal.`은 예제일 뿐입니다.
iOS/Android 노드는 `local.` 및 구성된 광역 도메인을 모두 검색합니다.

### 게이트웨이 설정(권장)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet만(권장)
  discovery: { wideArea: { enabled: true } }, // 광역 DNS-SD 게시 활성화
}
```

### 일회성 DNS 서버 설정(게이트웨이 호스트)

```bash
openclaw dns setup --apply
```

이는 CoreDNS를 설치하고 다음과 같이 구성합니다:

- 게이트웨이의 Tailscale 인터페이스에서만 포트 53에서 수신
- 선택한 도메인(예: `openclaw.internal.`)을 `~/.openclaw/dns/<domain>.db`에서 제공

tailnet에 연결된 머신에서 검증:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS 설정

Tailscale 관리 콘솔에서:

- 게이트웨이의 tailnet IP(UDP/TCP 53)를 가리키는 네임서버를 추가합니다.
- 검색 도메인이 해당 네임서버를 사용하도록 분할 DNS를 추가합니다.

클라이언트가 tailnet DNS를 수용하면 iOS 노드는 멀티캐스트 없이 검색 도메인에서 `_openclaw-gw._tcp`를 검색할 수 있습니다.

### 게이트웨이 리스너 보안(권장)

기본적으로 Gateway WS 포트(기본값 `18789`)는 루프백에 바인딩됩니다. LAN/tailnet 액세스의 경우 명시적으로 바인딩하고 인증을 활성화된 상태로 유지하세요.

tailnet만 설정의 경우:

- `~/.openclaw/openclaw.json`에서 `gateway.bind: "tailnet"`을 설정합니다.
- 게이트웨이를 다시 시작합니다(또는 macOS 메뉴 표시줄 앱을 다시 시작합니다).

## 광고하는 것

게이트웨이만 `_openclaw-gw._tcp`를 광고합니다.

## 서비스 유형

- `_openclaw-gw._tcp` — 게이트웨이 전송 비콘(macOS/iOS/Android 노드가 사용).

## TXT 키(비시크릿 힌트)

게이트웨이는 UI 흐름을 편리하게 하기 위해 작은 비시크릿 힌트를 광고합니다:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (TLS가 활성화된 경우만)
- `gatewayTlsSha256=<sha256>` (TLS가 활성화되고 지문을 사용할 수 있는 경우만)
- `canvasPort=<port>` (캔버스 호스트가 활성화된 경우만; 현재 `gatewayPort`와 동일)
- `sshPort=<port>` (재정의되지 않으면 기본값 22)
- `transport=gateway`
- `cliPath=<path>` (선택사항; 실행 가능한 `openclaw` 진입점의 절대 경로)
- `tailnetDns=<magicdns>` (선택사항; Tailnet을 사용할 수 있을 때의 힌트)

보안 참고:

- Bonjour/mDNS TXT 레코드는 **인증되지 않습니다**. 클라이언트는 TXT를 권위 있는 라우팅으로 처리해서는 안 됩니다.
- 클라이언트는 확인된 서비스 끝점(SRV + A/AAAA)을 사용하여 라우팅해야 합니다. `lanHost`, `tailnetDns`, `gatewayPort` 및 `gatewayTlsSha256`을 힌트로만 취급하세요.
- TLS 핀 고정은 광고된 `gatewayTlsSha256`이 이전에 저장된 핀을 재정의하도록 허용하지 않아야 합니다.
- iOS/Android 노드는 검색 기반 직접 연결을 **TLS만**으로 처리하고 처음 지문을 신뢰하기 전에 명시적인 사용자 확인이 필요합니다.

## macOS에서 디버깅

유용한 기본 제공 도구:

- 인스턴스 찾아보기:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- 하나의 인스턴스 확인(`<instance>` 교체):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

검색이 작동하지만 확인이 실패하면 일반적으로 LAN 정책 또는 mDNS 리졸버 문제가 발생합니다.

## 게이트웨이 로그에서 디버깅

게이트웨이는 롤링 로그 파일을 작성합니다(시작 시 `gateway log file: ...`로 출력됨). `bonjour:` 줄, 특히 다음을 찾으세요:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## iOS 노드에서 디버깅

iOS 노드는 `NWBrowser`를 사용하여 `_openclaw-gw._tcp`를 검색합니다.

로그를 캡처하려면:

- Settings → Gateway → Advanced → **Discovery Debug Logs**
- Settings → Gateway → Advanced → **Discovery Logs** → 재현 → **Copy**

로그는 브라우저 상태 전환 및 결과 집합 변경을 포함합니다.

## 일반적인 오류 모드

- **Bonjour는 네트워크를 넘지 못함**: Tailnet 또는 SSH를 사용하세요.
- **멀티캐스트 차단**: 일부 Wi‑Fi 네트워크는 mDNS를 비활성화합니다.
- **절전/인터페이스 이탈**: macOS는 일시적으로 mDNS 결과를 삭제할 수 있습니다. 재시도하세요.
- **검색은 작동하지만 확인이 실패함**: 머신 이름을 간단하게 유지합니다(이모지 또는 구두점 피함), 게이트웨이를 다시 시작합니다. 서비스 인스턴스 이름은 호스트 이름에서 파생되므로 과도하게 복잡한 이름은 일부 리졸버를 혼동할 수 있습니다.

## 이스케이프된 인스턴스 이름(`\032`)

Bonjour/DNS‑SD는 종종 서비스 인스턴스 이름의 바이트를 10진수 `\DDD` 시퀀스로 이스케이프합니다(예: 공백은 `\032`가 됨).

- 이것은 프로토콜 수준에서 정상입니다.
- UI는 표시용으로 디코드해야 합니다(iOS는 `BonjourEscapes.decode` 사용).

## 비활성화 / 구성

- `OPENCLAW_DISABLE_BONJOUR=1`은 광고를 비활성화합니다(레거시: `OPENCLAW_DISABLE_BONJOUR`).
- `~/.openclaw/openclaw.json`의 `gateway.bind`는 게이트웨이 바인드 모드를 제어합니다.
- `OPENCLAW_SSH_PORT`는 TXT에서 광고된 SSH 포트를 재정의합니다(레거시: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS`는 TXT에서 MagicDNS 힌트를 게시합니다(레거시: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH`는 광고된 CLI 경로를 재정의합니다(레거시: `OPENCLAW_CLI_PATH`).

## 관련 문서

- 검색 정책 및 전송 선택: [Discovery](/gateway/discovery)
- 노드 페어링 + 승인: [Gateway pairing](/gateway/pairing)
