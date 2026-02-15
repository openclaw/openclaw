---
summary: "Gateway WebSocket protocol: handshake, frames, versioning"
read_when:
  - Implementing or updating gateway WS clients
  - Debugging protocol mismatches or connect failures
  - Regenerating protocol schema/models
title: "Gateway Protocol"
x-i18n:
  source_hash: bdafac40d53565901b2df450617287664d77fe4ff52681fa00cab9046b2fd850
---

# 게이트웨이 프로토콜(WebSocket)

게이트웨이 WS 프로토콜은 **단일 제어 평면 + 노드 전송**입니다.
오픈클로. 모든 클라이언트(CLI, 웹 UI, macOS 앱, iOS/Android 노드, 헤드리스)
노드)는 WebSocket을 통해 연결하고 해당 **역할** + **범위**를 선언합니다.
악수 시간.

## 운송

- WebSocket, JSON 페이로드가 포함된 텍스트 프레임.
- 첫 번째 프레임은 **반드시** `connect` 요청이어야 합니다.

## 핸드셰이크(연결)

게이트웨이 → 클라이언트(연결 전 챌린지):

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

장치 토큰이 발급되면 `hello-ok`에는 다음도 포함됩니다.

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

## 프레이밍

- **요청**: `{type:"req", id, method, params}`
- **응답**: `{type:"res", id, ok, payload|error}`
- **이벤트**: `{type:"event", event, payload, seq?, stateVersion?}`

부작용이 있는 방법에는 **멱등성 키**가 필요합니다(스키마 참조).

## 역할 + 범위

### 역할

- `operator` = 제어 평면 클라이언트(CLI/UI/자동화).
- `node` = 기능 호스트(카메라/화면/캔버스/system.run).

### 범위(연산자)

일반적인 범위:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### 제한/명령/권한(노드)

노드는 연결 시 기능 주장을 선언합니다.

- `caps`: 상위 수준 기능 범주입니다.
- `commands`: 호출을 위한 명령 허용 목록입니다.
- `permissions`: 세분화된 토글(예: `screen.record`, `camera.capture`).

게이트웨이는 이를 **클레임**으로 처리하고 서버 측 허용 목록을 시행합니다.

## 존재감

- `system-presence`는 장치 ID로 입력된 항목을 반환합니다.
- 현재 상태 항목에는 `deviceId`, `roles` 및 `scopes`가 포함되므로 UI는 장치당 단일 행을 표시할 수 있습니다.
  **운영자**와 **노드**로 연결하는 경우에도 마찬가지입니다.

### 노드 도우미 메서드

- 노드는 `skills.bins`를 호출하여 현재 스킬 실행 파일 목록을 가져올 수 있습니다.
  자동 허용 확인을 위해.

## 임원 승인

- 실행 요청에 승인이 필요할 때 게이트웨이는 `exec.approval.requested`를 브로드캐스트합니다.
- 운영자 클라이언트는 `exec.approval.resolve`를 호출하여 해결합니다(`operator.approvals` 범위 필요).

## 버전 관리

- `PROTOCOL_VERSION`는 `src/gateway/protocol/schema.ts`에 거주합니다.
- 클라이언트는 `minProtocol` + `maxProtocol`를 보냅니다. 서버는 불일치를 거부합니다.
- 스키마 + 모델은 TypeBox 정의에서 생성됩니다.
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## 인증

- `OPENCLAW_GATEWAY_TOKEN` (또는 `--token`)가 설정된 경우, `connect.params.auth.token`
  일치해야 합니다. 그렇지 않으면 소켓이 닫힙니다.
- 페어링 후 게이트웨이는 연결 범위에 해당하는 **장치 토큰**을 발급합니다.
  역할 + 범위. 이는 `hello-ok.auth.deviceToken`에 반환되며 다음과 같아야 합니다.
  향후 연결을 위해 클라이언트에 의해 유지됩니다.
- 장치 토큰은 `device.token.rotate`를 통해 순환/해지될 수 있으며
  `device.token.revoke` (`operator.pairing` 범위 필요).

## 장치 ID + 페어링

- 노드는 다음에서 파생된 안정적인 장치 ID(`device.id`)를 포함해야 합니다.
  키페어 지문.
- 게이트웨이는 장치 + 역할별로 토큰을 발행합니다.
- 로컬 자동 승인이 아닌 경우 새 장치 ID에 대한 페어링 승인이 필요합니다.
  활성화되었습니다.
- **로컬** 연결에는 루프백과 게이트웨이 호스트의 자체 tailnet 주소가 포함됩니다.
  (따라서 동일한 호스트 tailnet 바인딩은 여전히 자동 승인될 수 있습니다).
- 모든 WS 클라이언트는 `connect`(운영자 + 노드) 동안 `device` ID를 포함해야 합니다.
  Control UI는 `gateway.controlUi.allowInsecureAuth`가 활성화된 경우 **만** 생략할 수 있습니다.
  (또는 깨진 유리 사용의 경우 `gateway.controlUi.dangerouslyDisableDeviceAuth`).
- 로컬이 아닌 연결은 서버가 제공하는 `connect.challenge` nonce에 서명해야 합니다.

## TLS + 고정

- WS 연결에는 TLS가 지원됩니다.
- 클라이언트는 선택적으로 게이트웨이 인증서 지문을 고정할 수 있습니다(`gateway.tls` 참조).
  config + `gateway.remote.tlsFingerprint` 또는 CLI `--tls-fingerprint`).

## 범위

이 프로토콜은 **전체 게이트웨이 API**(상태, 채널, 모델, 채팅,
에이전트, 세션, 노드, 승인 등). 정확한 표면은 다음에 의해 정의됩니다.
`src/gateway/protocol/schema.ts`의 TypeBox 스키마.
