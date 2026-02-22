---
summary: "게이트웨이 프로토콜을 위한 단일 진리 소스로서의 TypeBox 스키마"
read_when:
  - 프로토콜 스키마 또는 코드 생성 업데이트
title: "TypeBox"
---

# 프로토콜 진리의 소스로서의 TypeBox

마지막 업데이트: 2026-01-10

TypeBox는 TypeScript 우선 스키마 라이브러리입니다. **게이트웨이 WebSocket 프로토콜** (핸드셰이크, 요청/응답, 서버 이벤트)을 정의하는 데 사용됩니다. 이러한 스키마는 **런타임 검증**, **JSON 스키마 내보내기**, 및 macOS 앱용 **Swift 코드 생성**을 구동합니다. 하나의 진리의 원천이 모든 것을 생성합니다.

더 높은 수준의 프로토콜 컨텍스트가 필요하면 [게이트웨이 아키텍처](/ko-KR/concepts/architecture)로 시작하세요.

## 정신적 모델 (30초)

모든 게이트웨이 WS 메시지는 세 가지 프레임 중 하나입니다:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion? }`

첫 번째 프레임은 반드시 `connect` 요청이어야 합니다. 그 후, 클라이언트는 메서드 (예: `health`, `send`, `chat.send`)를 호출하고 이벤트 (예: `presence`, `tick`, `agent`)를 구독할 수 있습니다.

연결 흐름 (최소한):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

일반적인 메서드 및 이벤트:

| 카테고리  | 예제                                                      | 비고                                |
| --------- | --------------------------------------------------------- | ---------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect`는 반드시 첫 번째이어야 함            |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | 부작용이 있는 경우 `idempotencyKey` 필요     |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat에서 사용됨                  |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | 세션 관리                           |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | 게이트웨이 WS + 노드 작업            |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | 서버 푸시                           |

권위 있는 목록은 `src/gateway/server.ts` (`METHODS`, `EVENTS`)에 있습니다.

## 스키마의 위치

- 소스: `src/gateway/protocol/schema.ts`
- 런타임 검증자 (AJV): `src/gateway/protocol/index.ts`
- 서버 핸드셰이크 + 메서드 디스패치: `src/gateway/server.ts`
- 노드 클라이언트: `src/gateway/client.ts`
- 생성된 JSON 스키마: `dist/protocol.schema.json`
- 생성된 Swift 모델: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## 현재 파이프라인

- `pnpm protocol:gen`
  - JSON 스키마(draft‑07)를 `dist/protocol.schema.json`에 기록
- `pnpm protocol:gen:swift`
  - Swift 게이트웨이 모델 생성
- `pnpm protocol:check`
  - 두 생성기를 실행하고 출력이 커밋되었는지 확인

## 런타임에서 스키마 사용 방법

- **서버 측**: 모든 인바운드 프레임은 AJV로 검증됩니다. 핸드셰이크는 `ConnectParams`와 일치하는 `connect` 요청만 수락합니다.
- **클라이언트 측**: JS 클라이언트는 이벤트 및 응답 프레임을 사용하기 전에 검증합니다.
- **메서드 표면**: 게이트웨이는 `hello-ok`에서 지원되는 `methods` 및 `events`를 광고합니다.

## 예제 프레임

Connect (첫 번째 메시지):

```json
{
  "type": "req",
  "id": "c1",
  "method": "connect",
  "params": {
    "minProtocol": 2,
    "maxProtocol": 2,
    "client": {
      "id": "openclaw-macos",
      "displayName": "macos",
      "version": "1.0.0",
      "platform": "macos 15.1",
      "mode": "ui",
      "instanceId": "A1B2"
    }
  }
}
```

Hello-ok 응답:

```json
{
  "type": "res",
  "id": "c1",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 2,
    "server": { "version": "dev", "connId": "ws-1" },
    "features": { "methods": ["health"], "events": ["tick"] },
    "snapshot": {
      "presence": [],
      "health": {},
      "stateVersion": { "presence": 0, "health": 0 },
      "uptimeMs": 0
    },
    "policy": { "maxPayload": 1048576, "maxBufferedBytes": 1048576, "tickIntervalMs": 30000 }
  }
}
```

요청 + 응답:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

이벤트:

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## 최소 클라이언트 (Node.js)

최소 유용한 흐름: connect + health.

```ts
import { WebSocket } from "ws";

const ws = new WebSocket("ws://127.0.0.1:18789");

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "req",
      id: "c1",
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "cli",
          displayName: "example",
          version: "dev",
          platform: "node",
          mode: "cli",
        },
      },
    }),
  );
});

ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type === "res" && msg.id === "c1" && msg.ok) {
    ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
  }
  if (msg.type === "res" && msg.id === "h1") {
    console.log("health:", msg.payload);
    ws.close();
  }
});
```

## Worked example: add a method end‑to‑end

Example: add a new `system.echo` request that returns `{ ok: true, text }`.

1. **스키마 (진리의 소스)**

`src/gateway/protocol/schema.ts`에 추가:

```ts
export const SystemEchoParamsSchema = Type.Object(
  { text: NonEmptyString },
  { additionalProperties: false },
);

export const SystemEchoResultSchema = Type.Object(
  { ok: Type.Boolean(), text: NonEmptyString },
  { additionalProperties: false },
);
```

두 종류 모두 `ProtocolSchemas`에 추가하고 타입을 내보냅니다:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **검증**

`src/gateway/protocol/index.ts`에서 AJV 검증기를 내보냅니다:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **서버 동작**

`src/gateway/server-methods/system.ts`에 핸들러를 추가합니다:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

`src/gateway/server-methods.ts`에 `systemHandlers`를 이미 병합한 후, `METHODS`에 `"system.echo"`를 `src/gateway/server.ts`에 추가합니다.

4. **재생성**

```bash
pnpm protocol:check
```

5. **테스트 + 문서**

`src/gateway/server.*.test.ts`에 서버 테스트를 추가하고 문서에 메서드를 기재하세요.

## Swift codegen 동작

Swift 생성기는 다음을 내보냅니다:

- `GatewayFrame` enum (종류: `req`, `res`, `event`, `unknown`)
- 강한 유형의 페이로드 구조체/열거형
- `ErrorCode` 값과 `GATEWAY_PROTOCOL_VERSION`

알 수 없는 프레임 유형은 호환성을 위해 원시 페이로드로 보존됩니다.

## 버전 관리 + 호환성

- `PROTOCOL_VERSION`은 `src/gateway/protocol/schema.ts`에 있습니다.
- 클라이언트는 `minProtocol` + `maxProtocol`을 전송하고, 서버는 불일치를 거절합니다.
- Swift 모델은 알 수 없는 프레임 유형을 보존하여 오래된 클라이언트를 깨뜨리지 않도록 합니다.

## 스키마 패턴 및 규약

- 대부분의 객체는 엄격한 페이로드를 위해 `additionalProperties: false`를 사용합니다.
- `NonEmptyString`은 기본적인 ID 및 메서드/이벤트 명칭에 사용됩니다.
- 최상위 `GatewayFrame`은 `type`에 대한 **discriminator**를 사용합니다.
- 부작용이 있는 메서드는 보통 파라미터에 `idempotencyKey`를 요구합니다 (예: `send`, `poll`, `agent`, `chat.send`).

## 라이브 스키마 JSON

생성된 JSON 스키마는 리포지토리의 `dist/protocol.schema.json`에 있습니다. 게시된 원본 파일은 보통 다음에서 사용 가능합니다:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## 스키마를 변경할 때

1. TypeBox 스키마를 업데이트합니다.
2. `pnpm protocol:check`를 실행합니다.
3. 재생성된 스키마와 Swift 모델을 커밋합니다.