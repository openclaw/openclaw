---
summary: "SSH 터널, 터널 및 tailnet을 사용한 원격 액세스"
read_when:
  - 원격 게이트웨이 설정 실행 또는 문제 해결
title: "원격 액세스"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/remote.md
  workflow: 15
---

# 원격 액세스(SSH, 터널 및 tailnet)

이 저장소는 "SSH를 통한 원격"을 지원합니다. 전용 호스트(데스크톱/서버)에서 단일 게이트웨이(마스터)를 실행하고 클라이언트를 연결합니다.

- **운영자의 경우(자신/macOS app)**: SSH 터널링이 범용 폴백입니다.
- **노드의 경우(iOS/Android 및 향후 디바이스)**: **WebSocket** 게이트웨이(LAN/tailnet 또는 필요에 따라 SSH 터널)에 연결합니다.

## 핵심 아이디어

- 게이트웨이 WebSocket이 **루프백**의 구성된 포트(기본값 18789)에 바인딩됩니다.
- 원격 사용의 경우 해당 루프백 포트를 SSH를 통해 전달합니다(또는 tailnet/VPN 사용).

## 일반적인 VPN/tailnet 설정(에이전트가 사는 곳)

게이트웨이 호스트를 "에이전트가 사는 곳"으로 생각하세요. 세션, 인증 프로파일, 채널 및 상태를 소유합니다.
노트북/데스크톱(및 노드)이 해당 호스트에 연결합니다.

### 1) tailnet의 항상 켜져 있는 게이트웨이(VPS 또는 홈 서버)

지속적인 호스트에서 게이트웨이를 실행하고 **Tailscale** 또는 SSH를 통해 연결하세요.

- **최고의 UX:** `gateway.bind: "loopback"`을 유지하고 Control UI에 **Tailscale Serve**를 사용합니다.
- **폴백:** 루프백 유지 + SSH 액세스가 필요한 모든 머신의 터널.
- **예:** [exe.dev](/install/exe-dev) (쉬운 VM) 또는 [Hetzner](/install/hetzner) (프로덕션 VPS).

이는 노트북이 자주 절전 모드인 경우 이상적입니다.

### 2) 홈 데스크톱이 게이트웨이, 노트북이 원격 제어

노트북이 에이전트를 실행하지 않습니다. 원격으로 연결합니다:

- macOS app의 **SSH를 통한 원격** 모드(설정 → 일반 → "OpenClaw 실행").
- app이 터널을 열고 관리하므로 WebChat + 상태 검사 "작동합니다."

실행북: [macOS remote access](/platforms/mac/remote).

### 3) 노트북이 게이트웨이, 다른 머신이 원격 액세스

게이트웨이를 로컬로 유지합니다:

- SSH 터널을 노트북으로, 또는
- 구성된 Tailscale Serve.

가이드: [Tailscale](/gateway/tailscale) 및 [Web overview](/web).

## 명령 흐름(실행되는 곳)

단일 게이트웨이 서비스가 상태 + 채널을 소유합니다. 노드는 주변입니다.

흐름 예(Telegram → 노드):

- Telegram 메시지가 **게이트웨이**에 도착합니다.
- 게이트웨이가 **에이전트**를 실행하고 노드 도구를 호출할지 결정합니다.
- 게이트웨이가 게이트웨이 WebSocket(`node.*` RPC)을 통해 **노드**를 호출합니다.
- 노드가 결과를 반환합니다. 게이트웨이가 Telegram으로 다시 회신합니다.

참고:

- **노드가 게이트웨이 서비스를 실행하지 않습니다.** 의도적으로 고립되지 않은 한 호스트당 하나의 게이트웨이만 실행해야 합니다([Multiple gateways](/gateway/multiple-gateways) 참조).
- macOS app "노드 모드"는 단지 게이트웨이 WebSocket을 통한 노드 클라이언트입니다.

## SSH 터널(CLI + 도구)

원격 게이트웨이 WS로 로컬 터널을 만듭니다:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

터널이 올라가면:

- `openclaw health` 및 `openclaw status --deep`이 이제 `ws://127.0.0.1:18789`를 통해 원격 게이트웨이에 도달합니다.
- `openclaw gateway {status,health,send,agent,call}`은 또한 필요할 때 `--url`을 통해 전달된 URL을 대상으로 할 수 있습니다.

참고: `18789`를 구성된 `gateway.port`로 교체합니다(또는 `--port`/`OPENCLAW_GATEWAY_PORT`).

## 관련 문서

자세한 설정 옵션은 원본 문서를 참조하세요([Security](/gateway/security), [Tailscale](/gateway/tailscale)).

## 보안 규칙(원격/VPN)

짧은 버전: **게이트웨이를 루프백만으로 유지**합니다.

- **루프백 + SSH/Tailscale Serve**는 가장 안전한 기본값입니다(공개 노출 없음).
- **루프백이 아닌 바인드**(`lan`/`tailnet`/`custom` 또는 루프백을 사용할 수 없을 때 `auto`)는 공격 표면을 확장합니다. 공유 토큰/암호 및 실제 방화벽이 필요합니다.
- `gateway.remote.token` / `.password`는 클라이언트 자격 증명 소스입니다. 서버 인증을 자체적으로 구성하지 않습니다.
- 로컬 호출 경로는 `gateway.auth.*`이 설정되지 않으면 폴백으로 `gateway.remote.*`를 사용할 수 있습니다.
- `gateway.remote.tlsFingerprint`는 `wss://` 사용 시 원격 TLS 인증서를 고정합니다.
- **Tailscale Serve**는 `gateway.auth.allowTailscale: true`일 때 ID 헤더를 통해 Control UI/WebSocket 트래픽을 인증할 수 있습니다. HTTP API 끝점은 여전히 토큰/암호 인증을 필요로 합니다. 이 토큰리스 흐름은 게이트웨이 호스트가 신뢰할 수 있다고 가정합니다. 토큰/암호를 어디서나 원하면 `false`로 설정하세요.

깊은 다이빙: [Security](/gateway/security).
