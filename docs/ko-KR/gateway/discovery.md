---
summary: "Node discovery and transports (Bonjour, Tailscale, SSH) for finding the gateway"
read_when:
  - Implementing or changing Bonjour discovery/advertising
  - Adjusting remote connection modes (direct vs SSH)
  - Designing node discovery + pairing for remote nodes
title: "Discovery and Transports"
x-i18n:
  source_hash: e12172c181515bfa6aab8625ed3fbc335b80ba92e2b516c02c6066aeeb9f884c
---

# 발견 및 운송

OpenClaw에는 표면적으로 유사해 보이는 두 가지 뚜렷한 문제가 있습니다.

1. **운영자 원격 제어**: 다른 곳에서 실행되는 게이트웨이를 제어하는 macOS 메뉴 표시줄 앱입니다.
2. **노드 페어링**: iOS/Android(및 향후 노드)가 게이트웨이를 찾아 안전하게 페어링합니다.

설계 목표는 **노드 게이트웨이**(`openclaw gateway`)에서 모든 네트워크 검색/광고를 유지하고 클라이언트(mac 앱, iOS)를 소비자로 유지합니다.

## 용어

- **게이트웨이**: 상태(세션, 페어링, 노드 레지스트리)를 소유하고 채널을 실행하는 단일 장기 실행 게이트웨이 프로세스입니다. 대부분의 설정에서는 호스트당 하나씩을 사용합니다. 격리된 다중 게이트웨이 설정이 가능합니다.
- **게이트웨이 WS(제어 평면)**: 기본적으로 `127.0.0.1:18789`의 WebSocket 엔드포인트입니다. `gateway.bind`를 통해 LAN/테일넷에 바인딩될 수 있습니다.
- **직접 WS 전송**: LAN/tailnet을 향한 게이트웨이 WS 엔드포인트(SSH 없음).
- **SSH 전송(대체)**: SSH를 통해 `127.0.0.1:18789`을 전달하여 원격 제어합니다.
- **레거시 TCP 브리지(더 이상 사용되지 않음/제거됨)**: 이전 노드 전송([브리지 프로토콜](/gateway/bridge-protocol) 참조); 더 이상 검색을 위해 광고되지 않습니다.

프로토콜 세부정보:

- [게이트웨이 프로토콜](/gateway/protocol)
- [브리지 프로토콜(레거시)](/gateway/bridge-protocol)

## "직접"과 SSH를 모두 유지하는 이유

- **Direct WS**는 동일한 네트워크 및 tailnet 내에서 최고의 UX입니다.
  - Bonjour를 통해 LAN에서 자동 검색
  - 게이트웨이가 소유한 토큰 + ACL 페어링
  - 쉘 액세스가 필요하지 않습니다. 프로토콜 표면은 견고하고 감사 가능하게 유지될 수 있습니다.
- **SSH**는 여전히 보편적인 대체 방식입니다.
  - SSH 액세스가 가능한 모든 곳에서 작동합니다(관련되지 않은 네트워크에서도 가능).
  - 멀티캐스트/mDNS 문제에서 살아남음
  - SSH 외에 새로운 인바운드 포트가 필요하지 않습니다.

## 검색 입력(클라이언트가 게이트웨이의 위치를 파악하는 방법)

### 1) Bonjour / mDNS(LAN 전용)

Bonjour는 최선을 다하며 네트워크를 넘지 않습니다. 이는 "동일 LAN" 편의를 위해서만 사용됩니다.

목표 방향:

- **게이트웨이**는 Bonjour를 통해 WS 엔드포인트를 알립니다.
- 클라이언트는 "게이트웨이 선택" 목록을 찾아 표시한 다음 선택한 엔드포인트를 저장합니다.

문제 해결 및 비콘 세부 정보: [Bonjour](/gateway/bonjour).

#### 서비스 비콘 세부정보

- 서비스 유형:
  - `_openclaw-gw._tcp` (게이트웨이 전송 비콘)
- TXT 키(비밀):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (또는 광고되는 모든 것)
  - `gatewayPort=18789` (게이트웨이 WS + HTTP)
  - `gatewayTls=1` (TLS가 활성화된 경우에만)
  - `gatewayTlsSha256=<sha256>` (TLS가 활성화되고 지문이 사용 가능한 경우에만)
  - `canvasPort=18793` (기본 캔버스 호스트 포트, `/__openclaw__/canvas/` 제공)
  - `cliPath=<path>` (선택 사항, 실행 가능한 `openclaw` 진입점 또는 바이너리에 대한 절대 경로)
  - `tailnetDns=<magicdns>` (선택적 힌트, Tailscale을 사용할 수 있는 경우 자동 감지됨)

비활성화/재정의:

- `OPENCLAW_DISABLE_BONJOUR=1`는 광고를 비활성화합니다.
- `~/.openclaw/openclaw.json`의 `gateway.bind`는 게이트웨이 바인딩 모드를 제어합니다.
- `OPENCLAW_SSH_PORT`는 TXT에 알려진 SSH 포트를 재정의합니다(기본값은 22).
- `OPENCLAW_TAILNET_DNS`는 `tailnetDns` 힌트(MagicDNS)를 게시합니다.
- `OPENCLAW_CLI_PATH`는 알려진 CLI 경로를 재정의합니다.

### 2) 테일넷(교차 네트워크)

런던/비엔나 스타일 설정의 경우 Bonjour는 도움이 되지 않습니다. 권장되는 "직접" 대상은 다음과 같습니다.

- Tailscale MagicDNS 이름(선호) 또는 안정적인 tailnet IP.

게이트웨이가 Tailscale에서 실행 중임을 감지할 수 있는 경우 클라이언트(광역 비콘 포함)에 대한 선택적 힌트로 `tailnetDns`를 게시합니다.

### 3) 수동 / SSH 대상

직접 경로가 없거나 직접이 비활성화된 경우 클라이언트는 항상 루프백 게이트웨이 포트를 전달하여 SSH를 통해 연결할 수 있습니다.

[원격 접속](/gateway/remote)을 참조하세요.

## 운송 선택(클라이언트 정책)

권장되는 클라이언트 동작:

1. 페어링된 직접 엔드포인트가 구성되어 연결 가능한 경우 이를 사용합니다.
2. 그렇지 않고 Bonjour가 LAN에서 게이트웨이를 찾으면 원탭으로 "이 게이트웨이 사용" 옵션을 제공하고 이를 직접 엔드포인트로 저장합니다.
3. 그렇지 않고 tailnet DNS/IP가 구성되어 있으면 직접 시도하십시오.
4. 그렇지 않으면 SSH로 돌아갑니다.

## 페어링 + 인증(직접 전송)

게이트웨이는 노드/클라이언트 승인을 위한 정보 소스입니다.

- 게이트웨이에서 페어링 요청이 생성/승인/거부됩니다([게이트웨이 페어링](/gateway/pairing) 참조).
- 게이트웨이는 다음을 시행합니다.
  - 인증(토큰/키 쌍)
  - 범위/ACL(게이트웨이는 모든 방법에 대한 원시 프록시가 아닙니다)
  - 속도 제한

## 구성요소별 책임

- **게이트웨이**: 검색 비콘을 광고하고, 페어링 결정을 소유하며, WS 엔드포인트를 호스팅합니다.
- **macOS 앱**: 게이트웨이 선택을 돕고, 페어링 프롬프트를 표시하며, 대체 수단으로 SSH만 사용합니다.
- **iOS/Android 노드**: 편리하게 Bonjour를 탐색하고 페어링된 게이트웨이 WS에 연결합니다.
