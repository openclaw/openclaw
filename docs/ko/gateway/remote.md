---
summary: "SSH 터널 (Gateway WS) 및 tailnet을 사용한 원격 액세스"
read_when:
  - 원격 Gateway 설정을 실행하거나 문제를 해결할 때
title: "원격 액세스"
---

# 원격 액세스 (SSH, 터널, 그리고 tailnet)

이 리포지토리는 전용 호스트 (데스크톱/서버)에서 단일 Gateway (마스터)를 실행하고 클라이언트를 여기에 연결하는 방식으로 'SSH 를 통한 원격'을 지원합니다.

- **운영자 (본인 / macOS 앱)**: SSH 터널링이 범용적인 대안입니다.
- **노드 (iOS/Android 및 향후 디바이스)**: 필요에 따라 Gateway **WebSocket** (LAN/tailnet 또는 SSH 터널)을 통해 Gateway 에 연결합니다.

## 핵심 아이디어

- Gateway WebSocket 은 구성된 포트 (기본값 18789)에서 **loopback** 에 바인딩됩니다.
- 원격 사용 시, 해당 loopback 포트를 SSH 로 포워딩합니다 (또는 tailnet/VPN 을 사용하여 터널을 최소화합니다).

## 일반적인 VPN/tailnet 구성 (에이전트가 위치하는 곳)

**Gateway 호스트**를 '에이전트가 위치한 곳'으로 생각하십시오. 이 호스트가 세션, 인증 프로필, 채널, 상태를 소유합니다.
노트북/데스크톱 (및 노드)은 이 호스트에 연결합니다.

### 1. tailnet 에서 항상 실행되는 Gateway (VPS 또는 홈 서버)

지속적인 호스트에서 Gateway 를 실행하고 **Tailscale** 또는 SSH 로 접근합니다.

- **최상의 UX:** `gateway.bind: "loopback"` 를 유지하고 Control UI 에 **Tailscale Serve** 를 사용합니다.
- **대안:** loopback 을 유지하고 액세스가 필요한 모든 머신에서 SSH 터널을 사용합니다.
- **예시:** [exe.dev](/install/exe-dev) (간편한 VM) 또는 [Hetzner](/install/hetzner) (프로덕션 VPS).

노트북이 자주 잠자기 상태가 되지만 에이전트를 항상 실행하고 싶을 때 이상적입니다.

### 2. 홈 데스크톱이 Gateway 를 실행하고, 노트북이 원격 제어

노트북은 에이전트를 실행하지 않습니다. 원격으로 연결합니다:

- macOS 앱의 **Remote over SSH** 모드를 사용합니다 (설정 → 일반 → 'OpenClaw runs').
- 앱이 터널을 열고 관리하므로 WebChat + 상태 확인이 '그냥' 동작합니다.

런북: [macOS 원격 액세스](/platforms/mac/remote).

### 3. 노트북이 Gateway 를 실행하고, 다른 머신에서 원격 액세스

Gateway 를 로컬로 유지하되 안전하게 노출합니다:

- 다른 머신에서 노트북으로 SSH 터널을 연결하거나,
- Control UI 를 Tailscale Serve 로 제공하고 Gateway 는 loopback 전용으로 유지합니다.

가이드: [Tailscale](/gateway/tailscale) 및 [Web 개요](/web).

## 명령 흐름 (어디에서 무엇이 실행되는지)

하나의 gateway 서비스가 상태 + 채널을 소유합니다. 노드는 주변 장치입니다.

흐름 예시 (Telegram → 노드):

- Telegram 메시지가 **Gateway** 에 도착합니다.
- Gateway 가 **에이전트**를 실행하고 노드 도구를 호출할지 결정합니다.
- Gateway 가 Gateway WebSocket (`node.*` RPC) 을 통해 **노드**를 호출합니다.
- 노드가 결과를 반환하면, Gateway 가 Telegram 으로 응답을 보냅니다.

참고:

- **노드는 gateway 서비스를 실행하지 않습니다.** 의도적으로 격리된 프로필을 실행하지 않는 한, 호스트당 하나의 gateway 만 실행해야 합니다 ([Multiple gateways](/gateway/multiple-gateways) 참고).
- macOS 앱의 '노드 모드'는 Gateway WebSocket 을 통한 노드 클라이언트일 뿐입니다.

## SSH 터널 (CLI + 도구)

원격 Gateway WS 로의 로컬 터널을 생성합니다:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

With the tunnel up:

- `openclaw health` 및 `openclaw status --deep` 가 `ws://127.0.0.1:18789` 를 통해 원격 gateway 에 접근합니다.
- 필요 시 `openclaw gateway {status,health,send,agent,call}` 도 `--url` 를 통해 포워딩된 URL 을 대상으로 할 수 있습니다.

참고: `18789` 를 구성된 `gateway.port` (또는 `--port`/`OPENCLAW_GATEWAY_PORT`) 로 교체하십시오.
참고: `--url` 를 전달하면, CLI 는 설정이나 환경 변수 자격 증명으로 대체하지 않습니다.
`--token` 또는 `--password` 를 명시적으로 포함하십시오. 명시적 자격 증명이 없으면 오류입니다.

## CLI 원격 기본값

CLI 명령이 기본적으로 이를 사용하도록 원격 대상을 영구 저장할 수 있습니다:

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

gateway 가 loopback 전용일 때는 URL 을 `ws://127.0.0.1:18789` 로 유지하고 먼저 SSH 터널을 여십시오.

## SSH 를 통한 Chat UI

WebChat 은 더 이상 별도의 HTTP 포트를 사용하지 않습니다. SwiftUI 채팅 UI 는 Gateway WebSocket 에 직접 연결합니다.

- `18789` 을 SSH 로 포워딩한 다음 (위 참고), 클라이언트를 `ws://127.0.0.1:18789` 에 연결합니다.
- macOS 에서는 터널을 자동으로 관리하는 앱의 'Remote over SSH' 모드를 권장합니다.

## macOS 앱 'Remote over SSH'

macOS 메뉴 막대 앱은 동일한 설정을 엔드 투 엔드로 제어할 수 있습니다 (원격 상태 확인, WebChat, 음성 웨이크 포워딩).

런북: [macOS 원격 액세스](/platforms/mac/remote).

## 보안 규칙 (원격/VPN)

요약: 필요하다고 확신하지 않는 한 **Gateway 를 loopback 전용으로 유지**하십시오.

- **Loopback + SSH/Tailscale Serve** 가 가장 안전한 기본값입니다 (공개 노출 없음).
- **비 loopback 바인딩** (`lan`/`tailnet`/`custom`, 또는 loopback 을 사용할 수 없을 때 `auto`) 은 인증 토큰/비밀번호를 사용해야 합니다.
- `gateway.remote.token` 는 원격 CLI 호출에 **만** 사용됩니다 — 로컬 인증을 활성화하지 **않습니다**.
- `gateway.remote.tlsFingerprint` 는 `wss://` 사용 시 원격 TLS 인증서를 고정합니다.
- **Tailscale Serve** 는 `gateway.auth.allowTailscale: true` 인 경우 아이덴티티 헤더를 통해 인증할 수 있습니다.
  토큰/비밀번호를 사용하려면 `false` 로 설정하십시오.
- 브라우저 제어는 운영자 액세스로 취급하십시오: tailnet 전용 + 신중한 노드 페어링.

자세한 내용은 다음을 참고하십시오: [Security](/gateway/security).
