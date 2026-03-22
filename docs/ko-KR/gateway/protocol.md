---
summary: "Gateway WebSocket 프로토콜: 핸드셰이크, 프레임, 버전 관리"
read_when:
  - Gateway WS 클라이언트를 구현하거나 업데이트할 때
  - 프로토콜 불일치 또는 연결 실패를 디버깅할 때
  - 프로토콜 스키마/모델을 재생성할 때
title: "Gateway 프로토콜"
x-i18n:
  source_path: docs/gateway/protocol.md
---

# Gateway 프로토콜 (WebSocket)

Gateway WS 프로토콜은 OpenClaw의 **단일 컨트롤 플레인 + 노드 전송**입니다. 모든 클라이언트 (CLI, 웹 UI, macOS 앱, iOS/Android 노드, 헤드리스 노드)는 WebSocket으로 연결하고 핸드셰이크 시 **역할** + **범위**를 선언합니다.

## 전송

- WebSocket, JSON 페이로드가 포함된 텍스트 프레임.
- 첫 프레임은 반드시 `connect` 요청이어야 합니다.

## 핸드셰이크 (connect)

Gateway → 클라이언트 (사전 연결 챌린지):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "...", "ts": 1737264000000 }
}
```

클라이언트 → Gateway:

```json
{
  "type": "req",
  "id": "...",
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
    "auth": { "token": "..." },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "...",
      "signature": "...",
      "signedAt": 1737264000000,
      "nonce": "..."
    }
  }
}
```

Gateway → 클라이언트:

```json
{
  "type": "res",
  "id": "...",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

디바이스 토큰이 발급되면, `hello-ok`에 다음도 포함됩니다:

```json
{
  "auth": {
    "deviceToken": "...",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### 노드 예시

```json
{
  "type": "req",
  "id": "...",
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
    "auth": { "token": "..." },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "...",
      "signature": "...",
      "signedAt": 1737264000000,
      "nonce": "..."
    }
  }
}
```

## 프레임 구조

- **요청**: `{type:"req", id, method, params}`
- **응답**: `{type:"res", id, ok, payload|error}`
- **이벤트**: `{type:"event", event, payload, seq?, stateVersion?}`

부작용이 있는 메서드는 **멱등성 키**가 필요합니다 (스키마 참고).

## 역할 + 범위

### 역할

- `operator` = 컨트롤 플레인 클라이언트 (CLI/UI/자동화).
- `node` = 기능 호스트 (카메라/화면/캔버스/system.run).

### 범위 (operator)

주요 범위:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

메서드 범위는 첫 번째 게이트일 뿐입니다. `chat.send`를 통해 도달하는 일부 슬래시 명령은 그 위에 더 엄격한 명령 수준 검사를 적용합니다. 예를 들어, 영구적 `/config set` 및 `/config unset` 쓰기는 `operator.admin`이 필요합니다.

### 기능/명령/권한 (node)

노드는 연결 시 기능 클레임을 선언합니다:

- `caps`: 상위 기능 카테고리.
- `commands`: 호출을 위한 명령 허용 목록.
- `permissions`: 세분화된 토글 (예: `screen.record`, `camera.capture`).

Gateway는 이를 **클레임**으로 취급하고 서버 측 허용 목록을 강제합니다.

## 프레즌스

- `system-presence`는 디바이스 ID로 키가 지정된 항목을 반환합니다.
- 프레즌스 항목에는 `deviceId`, `roles`, `scopes`가 포함되어 UI가 **operator**와 **node**로 모두 연결되더라도 디바이스당 한 행을 표시할 수 있습니다.

### 노드 헬퍼 메서드

- 노드는 `skills.bins`를 호출하여 자동 허용 검사를 위한 현재 스킬 실행 파일 목록을 가져올 수 있습니다.

### 운영자 헬퍼 메서드

- 운영자는 `tools.catalog` (`operator.read`)를 호출하여 에이전트의 런타임 도구 카탈로그를 가져올 수 있습니다. 응답에는 그룹화된 도구와 출처 메타데이터가 포함됩니다:
  - `source`: `core` 또는 `plugin`
  - `pluginId`: `source="plugin"`일 때 플러그인 소유자
  - `optional`: 플러그인 도구가 선택 사항인지 여부

## 실행 승인

- 실행 요청에 승인이 필요한 경우, Gateway는 `exec.approval.requested`를 브로드캐스트합니다.
- 운영자 클라이언트는 `exec.approval.resolve`를 호출하여 해결합니다 (`operator.approvals` 범위 필요).
- `host=node`의 경우, `exec.approval.request`에는 `systemRunPlan` (정규화된 `argv`/`cwd`/`rawCommand`/세션 메타데이터)이 포함되어야 합니다. `systemRunPlan`이 누락된 요청은 거부됩니다.

## 버전 관리

- `PROTOCOL_VERSION`은 `src/gateway/protocol/schema.ts`에 있습니다.
- 클라이언트는 `minProtocol` + `maxProtocol`을 보내며, 서버는 불일치를 거부합니다.
- 스키마 + 모델은 TypeBox 정의에서 생성됩니다:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## 인증

- `OPENCLAW_GATEWAY_TOKEN` (또는 `--token`)이 설정된 경우, `connect.params.auth.token`이 일치해야 하며 그렇지 않으면 소켓이 닫힙니다.
- 페어링 후 Gateway는 연결 역할 + 범위에 맞는 **디바이스 토큰**을 발급합니다. `hello-ok.auth.deviceToken`에 반환되며 클라이언트가 향후 연결을 위해 저장해야 합니다.
- 디바이스 토큰은 `device.token.rotate` 및 `device.token.revoke`를 통해 순환/취소할 수 있습니다 (`operator.pairing` 범위 필요).
- 인증 실패에는 `error.details.code`와 복구 힌트가 포함됩니다:
  - `error.details.canRetryWithDeviceToken` (boolean)
  - `error.details.recommendedNextStep` (`retry_with_device_token`, `update_auth_configuration`, `update_auth_credentials`, `wait_then_retry`, `review_auth_configuration`)
- `AUTH_TOKEN_MISMATCH`에 대한 클라이언트 동작:
  - 신뢰할 수 있는 클라이언트는 캐시된 디바이스별 토큰으로 한 번의 제한된 재시도를 시도할 수 있습니다.
  - 재시도가 실패하면, 클라이언트는 자동 재연결 루프를 중지하고 운영자 조치 안내를 표시해야 합니다.

## 디바이스 ID + 페어링

- 노드는 키페어 지문에서 파생된 안정적인 디바이스 ID(`device.id`)를 포함해야 합니다.
- Gateway는 디바이스 + 역할별로 토큰을 발급합니다.
- 로컬 자동 승인이 활성화되지 않은 한, 새 디바이스 ID에는 페어링 승인이 필요합니다.
- **로컬** 연결에는 루프백과 Gateway 호스트 자체의 tailnet 주소가 포함됩니다 (동일 호스트 tailnet 바인드가 여전히 자동 승인할 수 있도록).
- 모든 WS 클라이언트는 `connect` 중에 `device` ID를 포함해야 합니다 (operator + node).
  Control UI는 다음 모드에서만 생략할 수 있습니다:
  - 로컬호스트 전용 비보안 HTTP 호환성을 위한 `gateway.controlUi.allowInsecureAuth=true`.
  - `gateway.controlUi.dangerouslyDisableDeviceAuth=true` (비상용, 심각한 보안 다운그레이드).
- 모든 연결은 서버가 제공한 `connect.challenge` nonce에 서명해야 합니다.

### 디바이스 인증 마이그레이션 진단

챌린지 서명 이전 동작을 사용하는 레거시 클라이언트의 경우, `connect`는 이제 `error.details.code` 아래에 안정적인 `error.details.reason`과 함께 `DEVICE_AUTH_*` 세부 코드를 반환합니다.

일반적인 마이그레이션 실패:

| 메시지                      | details.code                     | details.reason           | 의미                                             |
| --------------------------- | -------------------------------- | ------------------------ | ------------------------------------------------ |
| `device nonce required`     | `DEVICE_AUTH_NONCE_REQUIRED`     | `device-nonce-missing`   | 클라이언트가 `device.nonce`를 생략 (또는 빈 값). |
| `device nonce mismatch`     | `DEVICE_AUTH_NONCE_MISMATCH`     | `device-nonce-mismatch`  | 클라이언트가 오래된/잘못된 nonce로 서명.         |
| `device signature invalid`  | `DEVICE_AUTH_SIGNATURE_INVALID`  | `device-signature`       | 서명 페이로드가 v2 페이로드와 불일치.            |
| `device signature expired`  | `DEVICE_AUTH_SIGNATURE_EXPIRED`  | `device-signature-stale` | 서명된 타임스탬프가 허용 오차 범위 밖.           |
| `device identity mismatch`  | `DEVICE_AUTH_DEVICE_ID_MISMATCH` | `device-id-mismatch`     | `device.id`가 공개 키 지문과 불일치.             |
| `device public key invalid` | `DEVICE_AUTH_PUBLIC_KEY_INVALID` | `device-public-key`      | 공개 키 형식/정규화 실패.                        |

마이그레이션 대상:

- 항상 `connect.challenge`를 기다립니다.
- 서버 nonce를 포함하는 v2 페이로드에 서명합니다.
- `connect.params.device.nonce`에 동일한 nonce를 전송합니다.
- 선호 서명 페이로드는 `v3`로, 디바이스/클라이언트/역할/범위/토큰/nonce 필드 외에 `platform`과 `deviceFamily`를 바인딩합니다.
- 레거시 `v2` 서명은 호환성을 위해 계속 허용되지만, 페어링된 디바이스 메타데이터 고정은 재연결 시 명령 정책을 계속 제어합니다.

## TLS + 핀닝

- TLS는 WS 연결에 지원됩니다.
- 클라이언트는 선택적으로 Gateway 인증서 지문을 핀닝할 수 있습니다 (`gateway.tls` 설정과 `gateway.remote.tlsFingerprint` 또는 CLI `--tls-fingerprint` 참고).

## 범위

이 프로토콜은 **전체 Gateway API** (상태, 채널, 모델, 채팅, 에이전트, 세션, 노드, 승인 등)를 노출합니다. 정확한 표면은 `src/gateway/protocol/schema.ts`의 TypeBox 스키마로 정의됩니다.
