---
summary: "게이트웨이 WebSocket 프로토콜: 핸드셰이크, 프레임, 버전 관리"
read_when:
  - 게이트웨이 WebSocket 클라이언트를 구현하거나 업데이트할 때
  - 프로토콜 불일치 또는 연결 실패를 디버깅할 때
  - 프로토콜 스키마/모델을 재생성할 때
title: "게이트웨이 프로토콜"
---

# 게이트웨이 프로토콜 (WebSocket)

게이트웨이 WebSocket 프로토콜은 OpenClaw의 **단일 제어 플레인(control plane) + 노드 전송** 수단입니다.
모든 클라이언트(CLI, 웹 UI, macOS 앱, iOS/Android 노드, 헤드리스 노드)는 WebSocket을 통해 연결하며,
핸드셰이크 시 **역할(role)** + **범위(scope)** 를 선언합니다.

## 전송 방식

- WebSocket, JSON 페이로드를 담은 텍스트 프레임.
- 첫 번째 프레임은 **반드시** `connect` 요청이어야 합니다.

## 핸드셰이크 (connect)

게이트웨이 → 클라이언트 (연결 전 챌린지):

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

디바이스 토큰이 발급될 때 `hello-ok`에는 다음도 포함됩니다:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### 노드 예시

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

## 프레임 구조

- **요청(Request)**: `{type:"req", id, method, params}`
- **응답(Response)**: `{type:"res", id, ok, payload|error}`
- **이벤트(Event)**: `{type:"event", event, payload, seq?, stateVersion?}`

부작용이 있는 메서드는 **멱등성 키(idempotency keys)** 가 필요합니다 (스키마 참조).

## 역할 + 범위

### 역할

- `operator` = 제어 플레인 클라이언트 (CLI/UI/자동화).
- `node` = 기능 호스트 (카메라/화면/캔버스/system.run).

### 범위 (operator)

주요 범위:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/commands/permissions (node)

노드는 연결 시 기능 클레임(capability claims)을 선언합니다:

- `caps`: 상위 수준 기능 카테고리.
- `commands`: 호출 허용 명령 목록(allowlist).
- `permissions`: 세분화된 토글 (예: `screen.record`, `camera.capture`).

게이트웨이는 이를 **클레임**으로 취급하며 서버 측 허용 목록을 적용합니다.

## 프레즌스(Presence)

- `system-presence`는 디바이스 ID를 키로 하는 항목을 반환합니다.
- 프레즌스 항목에는 `deviceId`, `roles`, `scopes`가 포함되어,
  동일 디바이스가 **operator**와 **node** 양쪽으로 연결되더라도 UI에서 한 행으로 표시할 수 있습니다.

### 노드 헬퍼 메서드

- 노드는 `skills.bins`를 호출하여 자동 허용 검사를 위한 현재 스킬 실행 파일 목록을 가져올 수 있습니다.

## Exec 승인

- exec 요청에 승인이 필요한 경우, 게이트웨이는 `exec.approval.requested`를 브로드캐스트합니다.
- 운영자 클라이언트는 `exec.approval.resolve`를 호출하여 처리합니다 (`operator.approvals` 범위 필요).

## 버전 관리

- `PROTOCOL_VERSION`은 `src/gateway/protocol/schema.ts`에 정의되어 있습니다.
- 클라이언트는 `minProtocol` + `maxProtocol`을 전송하며, 서버는 불일치 시 거부합니다.
- 스키마 + 모델은 TypeBox 정의로부터 생성됩니다:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## 인증

- `OPENCLAW_GATEWAY_TOKEN` (또는 `--token`)이 설정된 경우, `connect.params.auth.token`이
  일치해야 하며, 그렇지 않으면 소켓이 닫힙니다.
- 페어링 후, 게이트웨이는 연결 역할 + 범위에 한정된 **디바이스 토큰**을 발급합니다.
  이 토큰은 `hello-ok.auth.deviceToken`에 반환되며, 클라이언트는 이후 연결을 위해 저장해야 합니다.
- 디바이스 토큰은 `device.token.rotate` 및 `device.token.revoke`를 통해 교체/폐기할 수 있습니다
  (`operator.pairing` 범위 필요).

## 디바이스 ID + 페어링

- 노드는 키페어 지문에서 파생된 안정적인 디바이스 ID(`device.id`)를 포함해야 합니다.
- 게이트웨이는 디바이스 + 역할 단위로 토큰을 발급합니다.
- 로컬 자동 승인이 활성화되지 않은 경우, 새 디바이스 ID에 대한 페어링 승인이 필요합니다.
- **로컬** 연결에는 루프백과 게이트웨이 호스트 자체의 tailnet 주소가 포함됩니다
  (동일 호스트 tailnet 바인드도 자동 승인 가능).
- 모든 WebSocket 클라이언트는 `connect` 시 `device` ID를 포함해야 합니다 (operator + node).
  Control UI는 긴급 사용 시 `gateway.controlUi.dangerouslyDisableDeviceAuth`가
  활성화된 경우에만 생략할 수 있습니다.
- 비로컬 연결은 서버가 제공한 `connect.challenge` nonce에 서명해야 합니다.

## TLS + 핀 고정

- WebSocket 연결에 TLS가 지원됩니다.
- 클라이언트는 선택적으로 게이트웨이 인증서 지문을 핀 고정할 수 있습니다
  (`gateway.tls` 설정 및 `gateway.remote.tlsFingerprint` 또는 CLI `--tls-fingerprint` 참조).

## 범위

이 프로토콜은 **전체 게이트웨이 API** (상태, 채널, 모델, 채팅, 에이전트, 세션, 노드, 승인 등)를
노출합니다. 정확한 표면은 `src/gateway/protocol/schema.ts`의 TypeBox 스키마로 정의됩니다.
