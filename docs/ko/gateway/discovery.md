---
summary: "Gateway 를 찾기 위한 노드 디바이스 검색 및 전송 (Bonjour, Tailscale, SSH)"
read_when:
  - Bonjour 디바이스 검색/광고를 구현하거나 변경할 때
  - 원격 연결 모드 (직접 vs SSH) 를 조정할 때
  - 원격 노드를 위한 노드 디바이스 검색 + 페어링을 설계할 때
title: "디바이스 검색 및 전송"
---

# 디바이스 검색 & 전송

OpenClaw 에는 표면적으로는 비슷해 보이지만 서로 다른 두 가지 문제가 있습니다:

1. **운영자 원격 제어**: 다른 위치에서 실행 중인 Gateway 를 제어하는 macOS 메뉴 바 앱.
2. **노드 페어링**: iOS/Android (및 향후 노드) 가 Gateway 를 찾고 안전하게 페어링하는 과정.

설계 목표는 모든 네트워크 디바이스 검색/광고를 **Node Gateway** (`openclaw gateway`) 에 유지하고, 클라이언트 (mac 앱, iOS) 는 소비자 역할만 하도록 하는 것입니다.

## 용어

- **Gateway**: 상태 (세션, 페어링, 노드 레지스트리) 를 소유하고 채널을 실행하는 단일 장기 실행 Gateway 프로세스입니다. 대부분의 구성에서는 호스트당 하나를 사용하며, 격리된 다중 Gateway 구성도 가능합니다.
- **Gateway WS (제어 플레인)**: 기본적으로 `127.0.0.1:18789` 에 있는 WebSocket 엔드포인트이며, `gateway.bind` 를 통해 LAN/테일넷에 바인딩할 수 있습니다.
- **Direct WS transport**: LAN/테일넷을 향한 Gateway WS 엔드포인트 (SSH 없음).
- **SSH transport (대체 수단)**: SSH 를 통해 `127.0.0.1:18789` 을 포워딩하여 원격 제어합니다.
- **Legacy TCP bridge (사용 중단/제거됨)**: 이전 노드 전송 방식 ([Bridge protocol](/gateway/bridge-protocol) 참고); 더 이상 디바이스 검색에 광고되지 않습니다.

프로토콜 세부 사항:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## 왜 '직접' 과 SSH 를 모두 유지하는가

- **Direct WS** 는 동일 네트워크 및 테일넷 내에서 최고의 UX 를 제공합니다:
  - Bonjour 를 통한 LAN 자동 디바이스 검색
  - Gateway 가 소유하는 페어링 토큰 + ACL
  - 셸 접근 불필요; 프로토콜 표면을 엄격하고 감사 가능하게 유지
- **SSH** 는 범용적인 대체 수단으로 남아 있습니다:
  - SSH 접근이 가능한 어디서든 동작 (서로 관련 없는 네트워크 간에도 가능)
  - 멀티캐스트/mDNS 문제를 회피
  - SSH 외에 새로운 인바운드 포트를 요구하지 않음

## 디바이스 검색 입력 (클라이언트가 Gateway 위치를 알게 되는 방법)

### 1. Bonjour / mDNS (LAN 전용)

Bonjour 는 최선형(best-effort) 이며 네트워크를 넘지 않습니다. "동일 LAN" 편의성을 위해서만 사용됩니다.

대상 방향:

- **Gateway** 가 Bonjour 를 통해 자신의 WS 엔드포인트를 광고합니다.
- 클라이언트는 이를 탐색하여 "Gateway 선택" 목록을 표시한 다음, 선택된 엔드포인트를 저장합니다.

문제 해결 및 비콘 세부 사항: [Bonjour](/gateway/bonjour).

#### 서비스 비콘 세부 사항

- 서비스 유형:
  - `_openclaw-gw._tcp` (Gateway 전송 비콘)
- TXT 키 (비밀 아님):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (또는 광고되는 값)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (TLS 가 활성화된 경우에만)
  - `gatewayTlsSha256=<sha256>` (TLS 가 활성화되어 있고 지문이 사용 가능한 경우에만)
  - `canvasPort=18793` (기본 캔버스 호스트 포트; `/__openclaw__/canvas/` 제공)
  - `cliPath=<path>` (선택 사항; 실행 가능한 `openclaw` 엔트리포인트 또는 바이너리의 절대 경로)
  - `tailnetDns=<magicdns>` (선택적 힌트; Tailscale 사용 가능 시 자동 감지)

비활성화/오버라이드:

- `OPENCLAW_DISABLE_BONJOUR=1` 은 광고를 비활성화합니다.
- `gateway.bind` 은 `~/.openclaw/openclaw.json` 에서 Gateway 바인드 모드를 제어합니다.
- `OPENCLAW_SSH_PORT` 는 TXT 에 광고되는 SSH 포트를 오버라이드합니다 (기본값 22).
- `OPENCLAW_TAILNET_DNS` 은 `tailnetDns` 힌트 (MagicDNS) 를 게시합니다.
- `OPENCLAW_CLI_PATH` 는 광고되는 CLI 경로를 오버라이드합니다.

### 2. Tailnet (네트워크 간)

런던/비엔나 스타일의 구성에서는 Bonjour 가 도움이 되지 않습니다. 권장되는 '직접' 대상은 다음과 같습니다:

- Tailscale MagicDNS 이름 (권장) 또는 안정적인 테일넷 IP.

Gateway 가 Tailscale 환경에서 실행 중임을 감지할 수 있는 경우, 클라이언트 (광역 비콘 포함) 를 위한 선택적 힌트로 `tailnetDns` 을 게시합니다.

### 3. 수동 / SSH 대상

직접 경로가 없거나 (또는 직접이 비활성화된 경우), 클라이언트는 언제든지 loopback Gateway 포트를 포워딩하여 SSH 를 통해 연결할 수 있습니다.

자세한 내용은 [Remote access](/gateway/remote) 를 참고하십시오.

## 전송 선택 (클라이언트 정책)

권장되는 클라이언트 동작:

1. 페어링된 직접 엔드포인트가 구성되어 있고 도달 가능하면 이를 사용합니다.
2. 그렇지 않고 Bonjour 가 LAN 에서 Gateway 를 찾으면, 원탭 "이 Gateway 사용" 선택지를 제공하고 이를 직접 엔드포인트로 저장합니다.
3. 그렇지 않고 테일넷 DNS/IP 가 구성되어 있으면 직접 연결을 시도합니다.
4. 그 외의 경우 SSH 로 대체합니다.

## 페어링 + 인증 (직접 전송)

Gateway 는 노드/클라이언트 승인에 대한 단일 진실 원천입니다.

- 페어링 요청은 Gateway 에서 생성/승인/거부됩니다 ([Gateway pairing](/gateway/pairing) 참고).
- Gateway 는 다음을 강제합니다:
  - 인증 (토큰 / 키페어)
  - 범위/ACL (Gateway 는 모든 메서드에 대한 원시 프록시가 아님)
  - 속도 제한

## 구성 요소별 책임

- **Gateway**: 디바이스 검색 비콘을 광고하고, 페어링 결정을 소유하며, WS 엔드포인트를 호스팅합니다.
- **macOS 앱**: Gateway 선택을 돕고, 페어링 프롬프트를 표시하며, 대체 수단으로만 SSH 를 사용합니다.
- **iOS/Android 노드**: 편의 기능으로 Bonjour 를 탐색하고, 페어링된 Gateway WS 에 연결합니다.
