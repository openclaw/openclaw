---
read_when:
    - 프로토콜 스키마 또는 codegen 업데이트
summary: 게이트웨이 프로토콜의 단일 정보 소스인 TypeBox 스키마
title: 타입박스
x-i18n:
    generated_at: "2026-02-08T15:52:29Z"
    model: gtx
    provider: google-translate
    source_hash: 72fb8a1244edd84bbf50359722c73c00aef79b744c7b17e2a68122cebb055dc0
    source_path: concepts/typebox.md
    workflow: 15
---

# 프로토콜 진실 소스로서의 TypeBox

최종 업데이트 날짜: 2026-01-10

TypeBox는 TypeScript 우선 스키마 라이브러리입니다. 우리는 이를 정의하는 데 사용합니다. **게이트웨이
웹소켓 프로토콜** (핸드셰이크, 요청/응답, 서버 이벤트). 해당 스키마
드라이브 **런타임 검증**, **JSON 스키마 내보내기**, 그리고 **스위프트 코드젠** 에 대한
macOS 앱. 진실의 단일 소스; 다른 모든 것은 생성됩니다.

더 높은 수준의 프로토콜 컨텍스트를 원한다면 다음으로 시작하십시오.
[게이트웨이 아키텍처](/concepts/architecture).

## 정신 모델(30초)

모든 Gateway WS 메시지는 다음 세 가지 프레임 중 하나입니다.

- **요구**: `{ type: "req", id, method, params }`
- **응답**: `{ type: "res", id, ok, payload | error }`
- **이벤트**: `{ type: "event", event, payload, seq?, stateVersion? }`

첫 번째 프레임 **~ 해야 하다** 가 되다 `connect` 요구. 그 후 고객이 전화할 수 있습니다.
방법(예: `health`, `send`, `chat.send`) 이벤트를 구독하고(예:
`presence`, `tick`, `agent`).

연결 흐름(최소):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

일반적인 방법 + 이벤트:

| Category  | Examples                                                  | Notes                              |
| --------- | --------------------------------------------------------- | ---------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` must be first            |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | side-effects need `idempotencyKey` |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat uses these                 |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | session admin                      |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + node actions          |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | server push                        |

신뢰할 수 있는 목록은 다음 위치에 있습니다. `src/gateway/server.ts` (`METHODS`, `EVENTS`).

## 스키마가 있는 곳

- 원천: `src/gateway/protocol/schema.ts`
- 런타임 유효성 검사기(AJV): `src/gateway/protocol/index.ts`
- 서버 핸드셰이크 + 메소드 디스패치: `src/gateway/server.ts`
- 노드 클라이언트: `src/gateway/client.ts`
- 생성된 JSON 스키마: `dist/protocol.schema.json`
- 생성된 Swift 모델: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## 현재 파이프라인

- `pnpm protocol:gen`
  - JSON 스키마(draft‑07)를 다음에 작성합니다. `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - Swift 게이트웨이 모델 생성
- `pnpm protocol:check`
  - 두 생성기를 모두 실행하고 출력이 커밋되었는지 확인합니다.

## 런타임 시 스키마가 사용되는 방식

- **서버 측**: 모든 인바운드 프레임은 AJV로 검증됩니다. 악수만
  받아들인다 `connect` 매개변수가 일치하는 요청 `ConnectParams`.
- **클라이언트 측**: JS 클라이언트는 이전에 이벤트 및 응답 프레임의 유효성을 검사합니다.
  그들을 사용합니다.
- **방법 표면**: 게이트웨이는 지원되는 것을 광고합니다. `methods` 그리고
  `events` ~에 `hello-ok`.

## 예시 프레임

연결(첫 번째 메시지):

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

안녕하세요-알겠습니다 응답:

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

## 최소 클라이언트(Node.js)

가장 작은 유용한 흐름: 연결 + 상태.

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

## 실제 예: 엔드투엔드 메서드 추가

예: 새로 추가 `system.echo` 반환 요청 `{ ok: true, text }`.

1. **스키마(진실의 소스)**

다음에 추가 `src/gateway/protocol/schema.ts`: 

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

둘 다 추가 `ProtocolSchemas` 내보내기 유형:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **확인**

~ 안에 `src/gateway/protocol/index.ts`, AJV 유효성 검사기를 내보냅니다.

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **서버 동작**

핸들러 추가 `src/gateway/server-methods/system.ts`: 

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

등록하세요 `src/gateway/server-methods.ts` (이미 병합되었습니다. `systemHandlers`),
그런 다음 추가 `"system.echo"` 에게 `METHODS` ~에 `src/gateway/server.ts`.

4. **재생성**

```bash
pnpm protocol:check
```

5. **테스트 + 문서**

서버 테스트 추가 `src/gateway/server.*.test.ts` 문서의 방법을 기록해 두세요.

## Swift 코드 생성 동작

Swift 생성기는 다음을 방출합니다.

- `GatewayFrame` 열거하다 `req`, `res`, `event`, 그리고 `unknown` 사례
- 강력한 유형의 페이로드 구조체/열거형
- `ErrorCode` 가치와 `GATEWAY_PROTOCOL_VERSION`

알 수 없는 프레임 유형은 향후 호환성을 위해 원시 페이로드로 보존됩니다.

## 버전 관리 + 호환성

- `PROTOCOL_VERSION` 에 거주 `src/gateway/protocol/schema.ts`.
- 클라이언트가 보냅니다 `minProtocol` + `maxProtocol`; 서버는 불일치를 거부합니다.
- Swift 모델은 이전 클라이언트가 중단되는 것을 방지하기 위해 알 수 없는 프레임 유형을 유지합니다.

## 스키마 패턴 및 규칙

- 대부분의 객체는 `additionalProperties: false` 엄격한 페이로드의 경우.
- `NonEmptyString` ID 및 메서드/이벤트 이름의 기본값입니다.
- 최상위 수준 `GatewayFrame` 사용하다 **판별자** ~에 `type`.
- 부작용이 있는 방법에는 일반적으로 다음이 필요합니다. `idempotencyKey` 매개변수에
  (예: `send`, `poll`, `agent`, `chat.send`).

## 라이브 스키마 JSON

생성된 JSON 스키마는 다음 저장소에 있습니다. `dist/protocol.schema.json`. 는
게시된 원시 파일은 일반적으로 다음 위치에서 구할 수 있습니다.

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## 스키마를 변경할 때

1. TypeBox 스키마를 업데이트합니다.
2. 달리다 `pnpm protocol:check`.
3. 재생성된 스키마 + Swift 모델을 커밋합니다.
