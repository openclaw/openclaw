---
summary: "Remote access using SSH tunnels (Gateway WS) and tailnets"
read_when:
  - Running or troubleshooting remote gateway setups
title: "Remote Access"
x-i18n:
  source_hash: 449d406f88c53dcc73b8f467854e57737a594a69d9cd94fe88e5578fcb25ad32
---

# 원격 액세스(SSH, 터널 및 tailnet)

이 저장소는 전용 호스트(데스크톱/서버)에서 단일 게이트웨이(마스터)를 실행하고 이에 클라이언트를 연결함으로써 "SSH를 통한 원격"을 지원합니다.

- **운영자(귀하/macOS 앱)**의 경우: SSH 터널링은 보편적인 대체 방법입니다.
- **노드(iOS/Android 및 향후 장치)**의 경우: 게이트웨이 **WebSocket**(필요에 따라 LAN/tailnet 또는 SSH 터널)에 연결합니다.

## 핵심 아이디어

- Gateway WebSocket은 구성된 포트의 **루프백**에 바인딩됩니다(기본값은 18789).
- 원격 사용의 경우 해당 루프백 포트를 SSH를 통해 전달하거나 tailnet/VPN을 사용하여 터널링을 줄입니다.

## 일반적인 VPN/tailnet 설정(에이전트가 있는 곳)

**게이트웨이 호스트**를 '에이전트가 거주하는 곳'으로 생각하세요. 세션, 인증 프로필, 채널 및 상태를 소유합니다.
노트북/데스크톱(및 노드)이 해당 호스트에 연결됩니다.

### 1) 테일넷(VPS 또는 홈 서버)의 Always-On 게이트웨이

영구 호스트에서 게이트웨이를 실행하고 **Tailscale** 또는 SSH를 통해 연결합니다.

- **최상의 UX:** `gateway.bind: "loopback"`를 유지하고 컨트롤 UI에 **Tailscale Serve**를 사용합니다.
- **폴백:** 액세스가 필요한 모든 시스템에서 루프백 + SSH 터널을 유지합니다.
- **예:** [exe.dev](/install/exe-dev) (쉬운 VM) 또는 [Hetzner](/install/hetzner) (프로덕션 VPS).

이는 노트북이 자주 잠자기 상태가 되지만 에이전트는 항상 켜져 있기를 원하는 경우에 이상적입니다.

### 2) 홈 데스크톱은 게이트웨이를 실행하고 노트북은 원격 제어합니다.

노트북은 에이전트를 실행하지 **않습니다**. 원격으로 연결됩니다.

- macOS 앱의 **Remote over SSH** 모드(설정 → 일반 → "OpenClaw 실행")를 사용하세요.
- 앱이 터널을 열고 관리하므로 WebChat + 상태 확인이 "작동"합니다.

런북: [macOS 원격 액세스](/platforms/mac/remote).

### 3) 노트북은 게이트웨이를 실행하고 다른 컴퓨터에서 원격 액세스합니다.

게이트웨이를 로컬로 유지하되 안전하게 노출하세요.

- 다른 컴퓨터에서 랩톱으로의 SSH 터널 또는
- Tailscale Control UI를 제공하고 게이트웨이 루프백 전용을 유지합니다.

가이드: [Tailscale](/gateway/tailscale) 및 [웹 개요](/web).

## 명령 흐름(무엇이 어디서 실행되는지)

하나의 게이트웨이 서비스는 상태 + 채널을 소유합니다. 노드는 주변 장치입니다.

흐름 예시(텔레그램 → 노드):

- 텔레그램 메시지가 **Gateway**에 도착합니다.
- 게이트웨이는 **에이전트**를 실행하고 노드 도구 호출 여부를 결정합니다.
- 게이트웨이는 게이트웨이 WebSocket(`node.*` RPC)을 통해 **노드**를 호출합니다.
- 노드는 결과를 반환합니다. 게이트웨이는 텔레그램으로 다시 응답합니다.

참고:

- **노드는 게이트웨이 서비스를 실행하지 않습니다.** 의도적으로 격리된 프로필을 실행하지 않는 한 호스트당 하나의 게이트웨이만 실행해야 합니다([다중 게이트웨이](/gateway/multiple-gateways) 참조).
- macOS 앱 "노드 모드"는 Gateway WebSocket을 통한 노드 클라이언트일 뿐입니다.

## SSH 터널(CLI + 도구)

원격 게이트웨이 WS에 대한 로컬 터널을 만듭니다.

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

터널을 위로 올린 상태에서:

- `openclaw health` 및 `openclaw status --deep`는 이제 `ws://127.0.0.1:18789`를 통해 원격 게이트웨이에 도달합니다.
- `openclaw gateway {status,health,send,agent,call}`는 필요할 때 `--url`를 통해 전달된 URL을 타겟팅할 수도 있습니다.

참고: `18789`를 구성된 `gateway.port`(또는 `--port`/`OPENCLAW_GATEWAY_PORT`)로 바꾸세요.
참고: `--url`를 전달하면 CLI는 구성 또는 환경 자격 증명으로 대체되지 않습니다.
`--token` 또는 `--password`를 명시적으로 포함합니다. 명시적 자격 증명이 누락되면 오류가 발생합니다.

## CLI 원격 기본값

CLI 명령이 기본적으로 이를 사용하도록 원격 대상을 유지할 수 있습니다.

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

게이트웨이가 루프백 전용인 경우 URL을 `ws://127.0.0.1:18789`에 유지하고 먼저 SSH 터널을 엽니다.

## SSH를 통한 채팅 UI

WebChat은 더 이상 별도의 HTTP 포트를 사용하지 않습니다. SwiftUI 채팅 UI는 Gateway WebSocket에 직접 연결됩니다.

- SSH를 통해 `18789`를 전달한 다음(위 참조) 클라이언트를 `ws://127.0.0.1:18789`에 연결합니다.
- macOS에서는 터널을 자동으로 관리하는 앱의 "Remote over SSH" 모드를 선호합니다.

## macOS 앱 “SSH를 통한 원격”

macOS 메뉴 표시줄 앱은 동일한 설정을 엔드투엔드(원격 상태 확인, WebChat 및 음성 깨우기 전달)로 구동할 수 있습니다.

런북: [macOS 원격 액세스](/platforms/mac/remote).

## 보안 규칙(원격/VPN)

짧은 버전: 바인드가 필요하다고 확신하지 않는 한 **게이트웨이 루프백 전용**을 유지하세요.

- **루프백 + SSH/Tailscale Serve**가 가장 안전한 기본값입니다(공개 노출 없음).
- **비루프백 바인드**(`lan`/`tailnet`/`custom` 또는 루프백을 사용할 수 없는 경우 `auto`)는 인증 토큰/비밀번호를 사용해야 합니다.
- `gateway.remote.token`는 **원격 CLI 호출에만** — 로컬 인증을 활성화하지 **않습니다**.
- `gateway.remote.tlsFingerprint`는 `wss://`를 사용할 때 원격 TLS 인증서를 고정합니다.
- **Tailscale Serve**는 `gateway.auth.allowTailscale: true`일 때 ID 헤더를 통해 인증할 수 있습니다.
  대신 토큰/비밀번호를 원하면 `false`로 설정하세요.
- 브라우저 제어를 운영자 액세스처럼 처리합니다. tailnet 전용 + 의도적인 노드 페어링.

심층 분석: [보안](/gateway/security).
