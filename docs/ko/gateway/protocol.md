---
summary: "Gateway WebSocket 프로토콜: 핸드셰이크, 프레임, 버저닝"
read_when:
  - Gateway WS 클라이언트 구현 또는 업데이트 시
  - 프로토콜 불일치 또는 연결 실패 디버깅 시
  - 프로토콜 스키마/모델 재생성 시
title: "Gateway 프로토콜"
---

# Gateway 프로토콜 (WebSocket)

Gateway WS 프로토콜은 OpenClaw 를 위한 **단일 제어 플레인 + 노드 전송**입니다. 모든 클라이언트 (CLI, 웹 UI, macOS 앱, iOS/Android 노드, 헤드리스
노드)는 WebSocket 으로 연결되며 핸드셰이크 시점에 자신의 **역할**

## Transport

- WebSocket, JSON 페이로드를 담은 텍스트 프레임.
- 첫 번째 프레임은 **반드시** `connect` 요청이어야 합니다.

## Handshake (연결)

Gateway → Client (사전 연결 챌린지):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Client → Gateway:

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

Gateway → Client:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

디바이스 토큰이 발급될 때, `hello-ok` 에는 다음도 포함됩니다:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Node 예시

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

## Framing

- **Request**: `{type:"req", id, method, params}`
- **Response**: `{type:"res", id, ok, payload|error}`
- **Event**: `{type:"event", event, payload, seq?, stateVersion?}`

부작용을 유발하는 메서드는 **멱등성 키**가 필요합니다 (스키마 참조).

## Roles + scopes

### Roles

- `operator` = 제어 플레인 클라이언트 (CLI/UI/자동화).
- `node` = 기능 호스트 (카메라/화면/캔버스/system.run).

### Scopes (operator)

공통 범위:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/commands/permissions (node)

노드는 연결 시 기능 클레임을 선언합니다:

- `caps`: 상위 수준의 기능 카테고리.
- `commands`: 호출을 위한 명령 허용 목록.
- `permissions`: 세부 토글 (예: `screen.record`, `camera.capture`).

Gateway 는 이를 **클레임**으로 취급하고 서버 측 허용 목록을 강제합니다.

## Presence

- `system-presence` 는 디바이스 식별자를 키로 하는 엔트리를 반환합니다.
- Presence 엔트리는 `deviceId`, `roles`, `scopes` 를 포함하므로,
  **operator** 와 **node** 로 동시에 연결되더라도 UI 가 디바이스당 단일 행을 표시할 수 있습니다.

### Node 헬퍼 메서드

- 노드는 자동 허용 검사에 사용하기 위해 현재 스킬 실행 파일 목록을 가져오는 `skills.bins` 를 호출할 수 있습니다.

## Exec 승인

- exec 요청에 승인이 필요할 때, Gateway 는 `exec.approval.requested` 를 브로드캐스트합니다.
- Operator 클라이언트는 `exec.approval.resolve` 를 호출하여 해결합니다 (`operator.approvals` 범위 필요).

## Versioning

- `PROTOCOL_VERSION` 는 `src/gateway/protocol/schema.ts` 에 존재합니다.
- 클라이언트는 `minProtocol` + `maxProtocol` 를 전송하며, 서버는 불일치를 거부합니다.
- 스키마 + 모델은 TypeBox 정의로부터 생성됩니다:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- `OPENCLAW_GATEWAY_TOKEN` (또는 `--token`) 가 설정된 경우, `connect.params.auth.token` 가 일치해야 하며
  그렇지 않으면 소켓이 닫힙니다.
- 페어링 후, Gateway(게이트웨이) 는 연결의 역할 + 범위에 스코프된 **디바이스 토큰**을 발급합니다. 이는 `hello-ok.auth.deviceToken` 에 반환되며 이후 연결을 위해 클라이언트가
  영구 저장해야 합니다.
- 디바이스 토큰은 `device.token.rotate` 및
  `device.token.revoke` 를 통해 회전/폐기할 수 있습니다 (`operator.pairing` 범위 필요).

## 디바이스 식별 + 페어링

- 노드는 키페어 지문에서 파생된 안정적인 디바이스 식별자 (`device.id`) 를 포함해야 합니다.
- Gateway 는 디바이스 + 역할별로 토큰을 발급합니다.
- 새로운 디바이스 ID 에 대해서는 로컬 자동 승인 기능이 활성화되지 않은 한 페어링 승인이 필요합니다.
- **로컬** 연결에는 loopback 과 Gateway 호스트의 자체 tailnet 주소가 포함됩니다
  (동일 호스트 tailnet 바인딩도 자동 승인될 수 있도록 하기 위함).
- 모든 WS 클라이언트는 `connect` 동안 (operator + node) `device` 식별자를 포함해야 합니다.
  제어 UI 는 `gateway.controlUi.allowInsecureAuth` 이 활성화된 경우에 **한해** 이를 생략할 수 있습니다
  (또는 비상용으로 `gateway.controlUi.dangerouslyDisableDeviceAuth`).
- 비로컬 연결은 서버가 제공한 `connect.challenge` nonce 에 서명해야 합니다.

## TLS + 핀닝

- WS 연결에 대해 TLS 가 지원됩니다.
- 클라이언트는 선택적으로 Gateway 인증서 지문을 핀닝할 수 있습니다
  (`gateway.tls` 설정 및 `gateway.remote.tlsFingerprint` 또는 CLI `--tls-fingerprint` 참조).

## Scope

이 프로토콜은 **전체 Gateway API** (상태, 채널, 모델, 채팅,
에이전트, 세션, 노드, 승인 등) 를 노출합니다. 정확한 표면은
`src/gateway/protocol/schema.ts` 에 있는 TypeBox 스키마로 정의됩니다.
