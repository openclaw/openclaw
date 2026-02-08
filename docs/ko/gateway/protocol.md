---
read_when:
    - 게이트웨이 WS 클라이언트 구현 또는 업데이트
    - 프로토콜 불일치 또는 연결 실패 디버깅
    - 프로토콜 스키마/모델 재생성
summary: '게이트웨이 WebSocket 프로토콜: 핸드셰이크, 프레임, 버전 관리'
title: 게이트웨이 프로토콜
x-i18n:
    generated_at: "2026-02-08T15:56:10Z"
    model: gtx
    provider: google-translate
    source_hash: bdafac40d53565901b2df450617287664d77fe4ff52681fa00cab9046b2fd850
    source_path: gateway/protocol.md
    workflow: 15
---

# 게이트웨이 프로토콜(WebSocket)

게이트웨이 WS 프로토콜은 **단일 제어 평면 + 노드 전송** 에 대한
오픈클로. 모든 클라이언트(CLI, 웹 UI, macOS 앱, iOS/Android 노드, 헤드리스)
노드) WebSocket을 통해 연결하고 선언합니다. **역할** + **범위** ~에
악수 시간.

## 수송

- WebSocket, JSON 페이로드가 포함된 텍스트 프레임.
- 첫 번째 프레임 **~ 해야 하다** 가 되다 `connect` 요구.

## 악수(연결)

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

디바이스 토큰이 발급되면, `hello-ok` 다음도 포함됩니다:

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

- **요구**: `{type:"req", id, method, params}`
- **응답**: `{type:"res", id, ok, payload|error}`
- **이벤트**: `{type:"event", event, payload, seq?, stateVersion?}`

부작용 방법에는 다음이 필요합니다. **멱등성 키** (스키마 참조)

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

- `caps`: 높은 수준의 기능 범주.
- `commands`: 호출을 위한 명령 허용 목록입니다.
- `permissions`: 세분화된 토글(예: `screen.record`, `camera.capture`).

게이트웨이는 이를 다음과 같이 처리합니다. **주장** 서버 측 허용 목록을 시행합니다.

## 있음

- `system-presence` 장치 ID로 입력된 항목을 반환합니다.
- 현재 상태 항목에는 다음이 포함됩니다. `deviceId`, `roles`, 그리고 `scopes` UI는 기기당 단일 행을 표시할 수 있습니다.
  둘 다로 연결하더라도 **연산자** 그리고 **마디**.

### 노드 도우미 메서드

- 노드는 호출할 수 있습니다. `skills.bins` 현재 스킬 실행 파일 목록을 가져오려면
  자동 허용 확인을 위해.

## 임원 승인

- 실행 요청에 승인이 필요할 때 게이트웨이는 브로드캐스트합니다. `exec.approval.requested`.
- 운영자 클라이언트는 전화로 해결합니다. `exec.approval.resolve` (요구 `operator.approvals` 범위).

## 버전 관리

- `PROTOCOL_VERSION` 에 거주 `src/gateway/protocol/schema.ts`.
- 클라이언트가 보냅니다 `minProtocol` + `maxProtocol`; 서버는 불일치를 거부합니다.
- 스키마 + 모델은 TypeBox 정의에서 생성됩니다.
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## 인증

- 만약에 `OPENCLAW_GATEWAY_TOKEN` (또는 `--token`)가 설정되었습니다. `connect.params.auth.token`
  일치해야 합니다. 그렇지 않으면 소켓이 닫힙니다.
- 페어링 후 게이트웨이는 **장치 토큰** 연결 범위에 속함
  역할 + 범위. 에 반환됩니다. `hello-ok.auth.deviceToken` 그리고 그래야 한다
  향후 연결을 위해 클라이언트에 의해 유지됩니다.
- 장치 토큰은 다음을 통해 교체/해지될 수 있습니다. `device.token.rotate` 그리고 
  `device.token.revoke` (요구 `operator.pairing` 범위).

## 장치 ID + 페어링

- 노드에는 안정적인 장치 ID(`device.id`)에서 파생
  키페어 지문.
- 게이트웨이는 장치 + 역할별로 토큰을 발행합니다.
- 로컬 자동 승인이 아닌 이상 새 장치 ID에 페어링 승인이 필요합니다.
  활성화되었습니다.
- **현지의** 연결에는 루프백과 게이트웨이 호스트의 자체 tailnet 주소가 포함됩니다.
  (따라서 동일한 호스트 tailnet 바인딩은 여전히 자동 승인될 수 있습니다).
- 모든 WS 클라이언트에는 다음이 포함되어야 합니다. `device` 동안의 정체성 `connect` (연산자 + 노드).
  Control UI는 생략 가능 **오직** 언제 `gateway.controlUi.allowInsecureAuth` 활성화되었습니다
  (또는 `gateway.controlUi.dangerouslyDisableDeviceAuth` 깨진 유리 사용을 위해).
- 로컬이 아닌 연결은 서버가 제공한 서명에 서명해야 합니다. `connect.challenge` 목하.

## TLS + 고정

- TLS는 WS 연결에 지원됩니다.
- 클라이언트는 선택적으로 게이트웨이 인증서 지문을 고정할 수 있습니다(참조: `gateway.tls`
  구성 플러스 `gateway.remote.tlsFingerprint` 또는 CLI `--tls-fingerprint`).

## 범위

이 프로토콜은 **전체 게이트웨이 API** (상태, 채널, 모델, 채팅,
에이전트, 세션, 노드, 승인 등). 정확한 표면은 다음에 의해 정의됩니다.
TypeBox 스키마 `src/gateway/protocol/schema.ts`.
