---
summary: "Bonjour/mDNS 디스커버리 + 디버깅 (게이트웨이 비콘, 클라이언트 및 일반적인 실패 모드)"
read_when:
  - macOS/iOS에서 Bonjour 디스커버리 문제 디버깅
  - mDNS 서비스 타입, TXT 레코드 또는 디스커버리 UX 변경
title: "Bonjour Discovery"
---

# Bonjour / mDNS 디스커버리

OpenClaw는 활성 게이트웨이(WebSocket 엔드포인트)를 발견하는 **LAN 전용 편리함**으로 Bonjour (mDNS / DNS‑SD)를 사용합니다. 이는 최선의 노력으로 수행되며 SSH 또는 Tailnet 기반의 연결을 대체하지 **않습니다**.

## Tailscale을 통한 광역 Bonjour (Unicast DNS‑SD)

노드와 게이트웨이가 다른 네트워크에 있는 경우, 멀티캐스트 mDNS가 경계를 넘지 않습니다. Tailscale을 통한 **Unicast DNS‑SD** ("Wide‑Area Bonjour")로 전환하여 동일한 디스커버리 UX를 유지할 수 있습니다.

상위 단계:

1. 게이트웨이 호스트에서 DNS 서버를 실행합니다 (Tailnet을 통해 접근 가능).
2. 전용 존 아래서 `_openclaw-gw._tcp`에 대한 DNS‑SD 레코드를 게시합니다
   (예: `openclaw.internal.`).
3. Tailscale **split DNS**를 구성하여 선택한 도메인이 클라이언트(iOS 포함)에 대해 해당 DNS 서버를 통해 해석되도록 설정합니다.

OpenClaw는 모든 디스커버리 도메인을 지원합니다; `openclaw.internal.`은 단지 예일 뿐입니다. iOS/Android 노드는 `local.`과 구성된 광역 도메인 모두에서 브라우징합니다.

### 게이트웨이 설정 (권장)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### 일회성 DNS 서버 설정 (게이트웨이 호스트)

```bash
openclaw dns setup --apply
```

이는 CoreDNS를 설치하고 다음을 설정합니다:

- 게이트웨이의 Tailscale 인터페이스에서만 포트 53에서 수신
- `~/.openclaw/dns/<domain>.db`에서 선택한 도메인 예: `openclaw.internal.` 제공

Tailnet에 연결된 머신에서 다음을 통해 검증합니다:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS 설정

Tailscale 관리자 콘솔에서:

- 게이트웨이의 tailnet IP(UDP/TCP 53)를 가리키는 네임서버를 추가합니다.
- split DNS를 추가하여 디스커버리 도메인이 해당 네임서버를 사용하도록 합니다.

클라이언트가 tailnet DNS를 수락하면 iOS 노드는 멀티캐스트 없이 디스커버리 도메인에서 `_openclaw-gw._tcp`를 브라우징할 수 있습니다.

### 게이트웨이 리스너 보안 (권장)

게이트웨이 WS 포트(기본값 `18789`)는 기본적으로 로컬 루프백에 바인드됩니다. LAN/tailnet 접근을 위해 명시적으로 바인드하고 인증을 유지하세요.

Tailnet 전용 설정의 경우:

- `~/.openclaw/openclaw.json`에서 `gateway.bind: "tailnet"`로 설정하십시오.
- 게이트웨이를 재시작하십시오 (또는 macOS 메뉴바 앱을 재시작하십시오).

## 광고 내용

오직 게이트웨이만이 `_openclaw-gw._tcp`를 광고합니다.

## 서비스 타입

- `_openclaw-gw._tcp` — 게이트웨이 전송 비콘 (macOS/iOS/Android 노드에서 사용).

## TXT 키 (비밀이 아닌 힌트)

게이트웨이는 UI 플로우를 편리하게 만들기 위해 작은 비밀이 아닌 힌트를 광고합니다:

- `role=gateway`
- `displayName=<친숙한 이름>`
- `lanHost=<호스트이름>.local`
- `gatewayPort=<포트>` (게이트웨이 WS + HTTP)
- `gatewayTls=1` (TLS가 활성화된 경우에만)
- `gatewayTlsSha256=<sha256>` (TLS 활성화 및 지문이 사용 가능한 경우에만)
- `canvasPort=<포트>` (캔버스 호스트가 활성화된 경우에만; 현재는 `gatewayPort`와 동일)
- `sshPort=<포트>` (기본적으로 22, 오버라이드되지 않았을 때)
- `transport=gateway`
- `cliPath=<경로>` (선택적; 실행 가능한 `openclaw` 진입점의 절대 경로)
- `tailnetDns=<magicdns>` (Tailnet 사용 가능한 경우의 선택적 힌트)

보안 주의사항:

- Bonjour/mDNS TXT 레코드는 **인증되지 않습니다**. 클라이언트는 TXT를 권위 있는 라우팅으로 다루지 않아야 합니다.
- 클라이언트는 해결된 서비스 엔드포인트 (SRV + A/AAAA)를 사용하여 라우팅해야 합니다. `lanHost`, `tailnetDns`, `gatewayPort`, 및 `gatewayTlsSha256`는 단지 힌트로만 취급해야 합니다.
- TLS 고정은 광고된 `gatewayTlsSha256`이 이전에 저장된 고정을 대체하지 않도록 해야 합니다.
- iOS/Android 노드는 디스커버리 기반의 직접 연결을 **TLS 전용**으로 취급하고 처음 발견한 지문을 신뢰하기 전에 사용자 확인을 요구해야 합니다.

## macOS에서의 디버깅

유용한 내장 도구:

- 인스턴스 브라우징:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- 하나의 인스턴스 확인 (대체 `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

브라우징이 작동하지만 해결이 실패할 경우, 일반적으로 LAN 정책 또는 mDNS 확인자 문제에 직면한 것입니다.

## 게이트웨이 로그에서의 디버깅

게이트웨이는 회전 로그 파일을 작성합니다 (시작 시 `gateway log file: ...`로 출력). 특히 다음과 같은 `bonjour:` 라인을 확인하십시오:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## iOS 노드에서의 디버깅

iOS 노드는 `NWBrowser`를 사용하여 `_openclaw-gw._tcp`를 발견합니다.

로그를 캡처하려면:

- 설정 → 게이트웨이 → 고급 → **Discovery Debug Logs**
- 설정 → 게이트웨이 → 고급 → **Discovery Logs** → 재현 → **복사**

로그에는 브라우저 상태 전환 및 결과 집합 변경이 포함됩니다.

## 일반적인 실패 모드

- **Bonjour는 네트워크를 넘지 않습니다**: Tailnet 또는 SSH를 사용하십시오.
- **멀티캐스트 차단**: 일부 Wi‑Fi 네트워크는 mDNS를 비활성화합니다.
- **수면 / 인터페이스 변화**: macOS는 일시적으로 mDNS 결과를 삭제할 수 있습니다; 다시 시도하십시오.
- **브라우징은 작동하지만 해결이 실패**: 기계 이름을 간단하게 유지하십시오 (이모지 또는 구두점을 피하십시오), 그 후 게이트웨이를 재시작하십시오. 서비스 인스턴스 이름은 호스트 이름에서 파생되므로 지나치게 복잡한 이름은 일부 확인자를 혼란시킬 수 있습니다.

## 인스턴스 이름의 탈출 (`\032`)

Bonjour/DNS‑SD는 종종 서비스 인스턴스 이름의 바이트를 소수 `\DDD` 시퀀스로 탈출합니다 (예: 공백은 `\032`가 됩니다).

- 프로토콜 레벨에서는 정상입니다.
- UI는 표시를 위해 디코드해야 합니다 (iOS는 `BonjourEscapes.decode`를 사용합니다).

## 비활성화 / 구성

- `OPENCLAW_DISABLE_BONJOUR=1` 광고를 비활성화합니다 (레거시: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind`는 `~/.openclaw/openclaw.json`에서 게이트웨이 바인드 모드를 제어합니다.
- `OPENCLAW_SSH_PORT`는 TXT에 광고된 SSH 포트를 재정의합니다 (레거시: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS`는 TXT에 MagicDNS 힌트를 게시합니다 (레거시: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH`는 광고된 CLI 경로를 재정의합니다 (레거시: `OPENCLAW_CLI_PATH`).

## 관련 문서

- 디스커버리 정책 및 전송 선택: [디바이스 검색](/ko-KR/gateway/discovery)
- 노드 연결 + 승인: [게이트웨이 연결](/ko-KR/gateway/pairing)