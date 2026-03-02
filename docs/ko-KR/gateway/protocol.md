---
summary: "게이트웨이 WebSocket 프로토콜: 핸드셰이크, 프레임, 버전 관리"
read_when:
  - 게이트웨이 WS 클라이언트 구현 또는 업데이트
  - 프로토콜 불일치 또는 연결 실패 디버깅
  - 프로토콜 스키마/모델 재생성
title: "게이트웨이 프로토콜"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/protocol.md
  workflow: 15
---

# 게이트웨이 프로토콜(WebSocket)

게이트웨이 WS 프로토콜은 OpenClaw의 **단일 제어 평면 + 노드 전송**입니다. 모든 클라이언트(CLI, web UI, macOS app, iOS/Android 노드, 헤드리스 노드)는 WebSocket을 통해 연결하고 핸드셰이크 시간에 **역할** + **범위**를 선언합니다.

## 전송

- WebSocket, JSON 페이로드가 있는 텍스트 프레임.
- 첫 프레임 **반드시** `connect` 요청이어야 합니다.

## 핸드셰이크(연결)

게이트웨이 → 클라이언트(사전 연결 챌린지):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

클라이언트 → 게이트웨이:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

게이트웨이 → 클라이언트:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

디바이스 토큰이 발급될 때 `hello-ok`는 또한 다음을 포함합니다:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### 노드 예제

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## 프레이밍

- **요청**: `{type:"req", id, method, params}`
- **응답**: `{type:"res", id, ok, payload|error}`
- **이벤트**: `{type:"event", event, payload, seq?, stateVersion?}`

부작용이 있는 메서드는 **멱등성 키**가 필요합니다(스키마 참조).

## 역할 + 범위

### 역할

- `operator` = 제어 평면 클라이언트(CLI/UI/자동화).
- `node` = 기능 호스트(카메라/스크린/캔버스/system.run).

### 범위(운영자)

일반 범위:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/commands/permissions(노드)

노드는 연결 시 기능 클레임을 선언합니다:

- `caps`: 높은 수준의 기능 범주.
- `commands`: 호출을 위한 명령 허용 목록.
- `permissions`: 세분화된 토글(예: `screen.record`, `camera.capture`).

게이트웨이는 이를 **클레임**으로 취급하고 서버 측 허용 목록을 적용합니다.

## 현재 상태

- `system-presence`는 디바이스 식별로 키 지정된 항목을 반환합니다.
- 현재 항목에는 `deviceId`, `역할` 및 `범위`가 포함되므로 UI는 **운영자**와 **노드**로 연결되는 단일 디바이스도 단일 행으로 표시할 수 있습니다.

## 버전 관리

- `PROTOCOL_VERSION`은 `src/gateway/protocol/schema.ts`에 있습니다.
- 클라이언트는 `minProtocol` + `maxProtocol`을 보냅니다. 서버가 불일치를 거부합니다.
- 스키마 + 모델은 TypeBox 정의에서 생성됩니다:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## 인증

- `OPENCLAW_GATEWAY_TOKEN` (또는 `--token`)이 설정되면 `connect.params.auth.token`이 일치하거나 소켓이 닫혀야 합니다.
- 페어링 후 게이트웨이는 연결 역할 + 범위로 범위 지정된 **디바이스 토큰**을 발급합니다. 향후 연결을 위해 클라이언트가 `hello-ok.auth.deviceToken`에서 유지해야 합니다.
- 디바이스 토큰은 `device.token.rotate` 및 `device.token.revoke` (`operator.pairing` 범위 필요)를 통해 회전/해지될 수 있습니다.

## 디바이스 신원 + 페어링

- 노드는 키페어 지문에서 파생된 안정적인 디바이스 신원(`device.id`)을 포함해야 합니다.
- 게이트웨이는 디바이스 + 역할당 토큰을 발급합니다.
- 로컬 자동 승인이 활성화되지 않는 한 새 디바이스 ID에 대해 페어링 승인이 필요합니다.
- **로컬** 연결에는 루프백과 게이트웨이 호스트의 자신의 tailnet 주소가 포함됩니다(동일 호스트 tailnet 바인드는 여전히 자동 승인할 수 있음).

## TLS + 핀 고정

- TLS는 WS 연결에 지원됩니다.
- 클라이언트는 선택적으로 게이트웨이 인증서 지문을 고정할 수 있습니다(`gateway.tls` 설정 + `gateway.remote.tlsFingerprint` 또는 CLI `--tls-fingerprint` 참조).

## 범위

이 프로토콜은 **전체 게이트웨이 API**(상태, 채널, 모델, 채팅, 에이전트, 세션, 노드, 승인 등)를 노출합니다. 정확한 표면은 `src/gateway/protocol/schema.ts`의 TypeBox 스키마로 정의됩니다.
