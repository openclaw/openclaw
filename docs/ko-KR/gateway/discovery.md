---
summary: "노드 검색 및 전송(Bonjour, Tailscale, SSH)을 사용하여 게이트웨이 찾기"
read_when:
  - Bonjour 검색/광고 구현 또는 변경
  - 원격 연결 모드 조정(직접 vs SSH)
  - 원격 노드에 대한 노드 검색 + 페어링 설계
title: "검색 및 전송"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/discovery.md
  workflow: 15
---

# 검색 & 전송

OpenClaw는 표면상 유사해 보이는 두 가지 고유한 문제가 있습니다:

1. **운영자 원격 제어**: macOS 메뉴 표시줄 앱이 다른 곳에서 실행 중인 게이트웨이를 제어.
2. **노드 페어링**: iOS/Android(및 향후 노드)가 게이트웨이를 찾아서 안전하게 페어링.

설계 목표는 **Node Gateway** (`openclaw gateway`)에 모든 네트워크 검색/광고를 유지하고 클라이언트(mac app, iOS)를 소비자로 유지하는 것입니다.

## 용어

- **게이트웨이**: 상태(세션, 페어링, 노드 레지스트리)를 소유하고 채널을 실행하는 단일 장시간 실행되는 게이트웨이 프로세스. 대부분의 설정은 호스트당 하나를 사용합니다. 고립된 다중 게이트웨이 설정이 가능합니다.
- **Gateway WS(제어 평면)**: 기본값 `127.0.0.1:18789`의 WebSocket 끝점; `gateway.bind`를 통해 LAN/tailnet에 바인딩할 수 있습니다.
- **직접 WS 전송**: LAN/tailnet이 향하는 Gateway WS 끝점(SSH 없음).
- **SSH 전송(폴백)**: `127.0.0.1:18789`를 SSH를 통해 전달하여 원격 제어.
- **레거시 TCP 브리지(더 이상 사용되지 않음/제거됨)**: 이전 노드 전송(참조: [Bridge protocol](/gateway/bridge-protocol)); 검색을 위해 더 이상 광고되지 않음.

프로토콜 세부 정보:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## "직접"과 SSH를 모두 유지하는 이유

- **Direct WS**는 동일한 네트워크 및 tailnet 내 최고의 UX입니다:
  - LAN에서 Bonjour를 통한 자동 검색
  - 게이트웨이가 소유한 페어링 토큰 + ACL
  - 셸 액세스가 필요하지 않음; 프로토콜 표면은 작고 감시 가능합니다
- **SSH**는 범용 폴백으로 유지됩니다:
  - SSH 액세스가 있는 곳이면 어디든 작동(관련 없는 네트워크도)
  - 멀티캐스트/mDNS 문제에서 살아남음
  - SSH 외에 새로운 인바운드 포트가 필요하지 않음

## 검색 입력(클라이언트가 게이트웨이의 위치를 알아내는 방법)

### 1) Bonjour / mDNS(LAN만)

Bonjour는 최선의 노력이며 네트워크를 넘지 못합니다. "동일 LAN" 편의용으로만 사용됩니다.

대상 방향:

- **게이트웨이**는 Bonjour를 통해 WS 끝점을 광고합니다.
- 클라이언트는 검색하고 "게이트웨이 선택" 목록을 표시한 다음 선택한 끝점을 저장합니다.

문제 해결 및 비콘 세부 정보: [Bonjour](/gateway/bonjour).

#### 서비스 비콘 세부 정보

- 서비스 유형:
  - `_openclaw-gw._tcp` (게이트웨이 전송 비콘)
- TXT 키(비시크릿):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (또는 광고되는 항목)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (TLS가 활성화된 경우만)
  - `gatewayTlsSha256=<sha256>` (TLS가 활성화되고 지문을 사용할 수 있는 경우만)
  - `canvasPort=<port>` (캔버스 호스트 포트; 캔버스 호스트가 활성화된 경우 현재 `gatewayPort`와 동일)
  - `cliPath=<path>` (선택사항; 실행 가능한 `openclaw` 진입점 또는 바이너리의 절대 경로)
  - `tailnetDns=<magicdns>` (선택사항; Tailscale을 사용할 수 있을 때의 힌트)

보안 참고:

- Bonjour/mDNS TXT 레코드는 **인증되지 않습니다**. 클라이언트는 TXT 값을 UX 힌트로만 취급해야 합니다.
- 라우팅(호스트/포트)은 TXT 제공 `lanHost`, `tailnetDns` 또는 `gatewayPort`를 통해 **확인된 서비스 끝점**(SRV + A/AAAA)을 선호해야 합니다.
- TLS 핀 고정은 광고된 `gatewayTlsSha256`이 이전에 저장된 핀을 재정의하도록 허용해서는 안 됩니다.
- iOS/Android 노드는 검색 기반 직접 연결을 **TLS만**으로 취급하고 처음 지문을 저장하기 전에 명시적 "이 지문 신뢰" 확인이 필요합니다(대역 외 검증).

비활성화/재정의:

- `OPENCLAW_DISABLE_BONJOUR=1`은 광고를 비활성화합니다.
- `~/.openclaw/openclaw.json`의 `gateway.bind`는 게이트웨이 바인드 모드를 제어합니다.
- `OPENCLAW_SSH_PORT`는 TXT에서 광고된 SSH 포트를 재정의합니다(기본값 22).
- `OPENCLAW_TAILNET_DNS`는 `tailnetDns` 힌트를 게시합니다(MagicDNS).
- `OPENCLAW_CLI_PATH`는 광고된 CLI 경로를 재정의합니다.

### 2) Tailnet(교차 네트워크)

London/Vienna 스타일 설정의 경우 Bonjour는 도움이 되지 않습니다. 권장 "직접" 대상은:

- Tailscale MagicDNS 이름(권장) 또는 안정적인 tailnet IP.

게이트웨이가 Tailscale에서 실행 중인지 감지할 수 있으면 클라이언트(광역 비콘 포함)를 위해 `tailnetDns`을 선택 힌트로 게시합니다.

### 3) 수동 / SSH 대상

직접 경로가 없거나 직접이 비활성화된 경우 클라이언트는 항상 SSH를 통해 연결하여 루프백 게이트웨이 포트를 전달할 수 있습니다.

참조: [Remote access](/gateway/remote).

## 전송 선택(클라이언트 정책)

권장 클라이언트 동작:

1. 페어링된 직접 끝점이 구성되고 도달 가능한 경우 사용하세요.
2. 그 외 Bonjour가 LAN에서 게이트웨이를 찾으면 "이 게이트웨이 사용" 선택을 제공하고 직접 끝점으로 저장하세요.
3. 그 외 tailnet DNS/IP가 구성된 경우 직접 시도하세요.
4. 그 외 SSH로 폴백하세요.

## 페어링 + 인증(직접 전송)

게이트웨이는 노드/클라이언트 승인의 소스입니다.

- 페어링 요청은 게이트웨이에서 생성/승인/거부됩니다([Gateway pairing](/gateway/pairing) 참조).
- 게이트웨이는 다음을 적용합니다:
  - 인증(토큰 / 키페어)
  - 범위/ACL(게이트웨이는 모든 메서드의 원시 프록시가 아님)
  - 속도 제한

## 구성 요소별 책임

- **게이트웨이**: 검색 비콘을 광고하고 페어링 결정을 소유하며 WS 끝점을 호스트합니다.
- **macOS app**: 게이트웨이를 선택하고 페어링 프롬프트를 표시하고 폴백으로만 SSH를 사용합니다.
- **iOS/Android 노드**: 편의상 Bonjour를 검색하고 페어링된 Gateway WS에 연결합니다.
