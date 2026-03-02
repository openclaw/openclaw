---
summary: "Gateway 프로토콜의 단일 진실 원천인 TypeBox 스키마"
read_when:
  - 프로토콜 스키마 또는 코드젠 업데이트
title: "TypeBox"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/concepts/typebox.md
  workflow: 15
---

# 프로토콜 진실 원천으로서의 TypeBox

마지막 업데이트: 2026-01-10

TypeBox는 TypeScript 우선 스키마 라이브러리입니다. 우리는 이를 사용하여 **Gateway WebSocket 프로토콜**(핸드셰이크, 요청/응답, 서버 이벤트)을 정의합니다. 이 스키마는 **런타임 유효성 검사**, **JSON 스키마 내보내기**, macOS 앱을 위한 **Swift 코드젠**을 구동합니다. 하나의 진실 원천; 다른 모든 것은 생성됩니다.

더 높은 수준의 프로토콜 컨텍스트를 원하면 [Gateway 아키텍처](/concepts/architecture)로 시작하세요.

## 정신 모델(30초)

모든 Gateway WS 메시지는 세 프레임 중 하나입니다:

- **요청**: `{ type: "req", id, method, params }`
- **응답**: `{ type: "res", id, ok, payload | error }`
- **이벤트**: `{ type: "event", event, payload, seq?, stateVersion? }`

첫 번째 프레임은 **반드시** `connect` 요청이어야 합니다. 그 후 클라이언트는 메서드(예: `health`, `send`, `chat.send`)를 호출하고 이벤트(예: `presence`, `tick`, `agent`)를 구독할 수 있습니다.

연결 흐름(최소):

```
클라이언트              Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

공통 메서드 + 이벤트:

| 카테고리 | 예제                                                      | 주의사항                         |
| -------- | --------------------------------------------------------- | -------------------------------- |
| 코어     | `connect`, `health`, `status`                             | `connect`는 먼저                 |
| 메시징   | `send`, `poll`, `agent`, `agent.wait`                     | 부작용에는 `idempotencyKey` 필요 |
| 채팅     | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat 사용                     |
| 세션     | `sessions.list`, `sessions.patch`, `sessions.delete`      | 세션 관리                        |
| 노드     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + 노드 액션           |
| 이벤트   | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | 서버 푸시                        |

권위있는 목록은 `src/gateway/server.ts` (`METHODS`, `EVENTS`)에 있습니다.

## 스키마가 있는 곳

- 소스: `src/gateway/protocol/schema.ts`
- 런타임 검증자(AJV): `src/gateway/protocol/index.ts`
- 서버 핸드셰이크 + 메서드 디스패치: `src/gateway/server.ts`
- 노드 클라이언트: `src/gateway/client.ts`
- 생성된 JSON 스키마: `dist/protocol.schema.json`
- 생성된 Swift 모델: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## 현재 파이프라인

- `pnpm protocol:gen`
  - JSON 스키마(draft‑07)를 `dist/protocol.schema.json`에 기록
- `pnpm protocol:gen:swift`
  - Swift Gateway 모델 생성
- `pnpm protocol:check`
  - 두 생성기를 실행하고 출력이 커밋되었는지 확인

## 스키마가 런타임에 어떻게 사용되는가

- **서버 측**: 모든 인바운드 프레임은 AJV로 유효성 검사됩니다. 핸드셰이크는 `ConnectParams`와 일치하는 `connect` 요청만 허용합니다.
- **클라이언트 측**: JS 클라이언트는 이벤트 및 응답 프레임을 사용하기 전에 유효성을 검사합니다.
- **메서드 표면**: Gateway는 `hello-ok`에서 지원되는 `methods` 및 `events`를 광고합니다.

## 예제 프레임

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

## 작업된 예제: 메서드를 끝에서 끝까지 추가

예제: 반환하는 새로운 `system.echo` 요청 추가 `{ ok: true, text }`.

1. **스키마(진실 원천)**

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

`ProtocolSchemas`에 추가하고 유형 내보내기:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **유효성 검사**

`src/gateway/protocol/index.ts`에서 AJV 검증자 내보내기:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **서버 동작**

`src/gateway/server-methods/system.ts`에 핸들러 추가:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

`src/gateway/server-methods.ts` (이미 `systemHandlers` 병합)에 등록한 다음 `src/gateway/server.ts`의 `METHODS`에 `"system.echo"`를 추가합니다.

4. **재생성**

```bash
pnpm protocol:check
```

5. **테스트 + 문서**

`src/gateway/server.*.test.ts`에 서버 테스트를 추가하고 문서에 메서드를 기록합니다.

## Swift 코드젠 동작

Swift 생성기는 다음을 발생합니다:

- `GatewayFrame` enum with `req`, `res`, `event`, and `unknown` cases
- 강하게 입력된 페이로드 구조체/열거형
- `ErrorCode` 값 및 `GATEWAY_PROTOCOL_VERSION`

알 수 없는 프레임 유형은 전향 호환성을 위해 원본 페이로드로 보존됩니다.

## 버전 관리 + 호환성

- `PROTOCOL_VERSION`은 `src/gateway/protocol/schema.ts`에 있습니다.
- 클라이언트는 `minProtocol` + `maxProtocol`을 보냅니다; 서버는 불일치를 거부합니다.
- Swift 모델은 이전 클라이언트를 손상시키지 않도록 알 수 없는 프레임 유형을 유지합니다.

## 스키마 패턴 및 컨벤션

- 대부분 객체는 엄격한 페이로드에 대해 `additionalProperties: false`를 사용합니다.
- `NonEmptyString`은 ID 및 메서드/이벤트 이름의 기본값입니다.
- 최상위 `GatewayFrame`은 `type`의 **판별자**를 사용합니다.
- 부작용이 있는 메서드는 일반적으로 params에서 `idempotencyKey` 필요합니다.
  (예제: `send`, `poll`, `agent`, `chat.send`).
- `agent`는 런타임 생성 오케스트레이션 컨텍스트에 대한 선택적 `internalEvents`를 허용합니다.
  (예제: 하위 에이전트/cron 작업 완료 핸드오프); 이를 내부 API 표면으로 취급합니다.

## 라이브 스키마 JSON

생성된 JSON 스키마는 `dist/protocol.schema.json` 리포지토리에 있습니다. 게시된 원본 파일은 일반적으로 다음에서 사용 가능합니다:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## 스키마를 변경할 때

1. TypeBox 스키마 업데이트.
2. `pnpm protocol:check` 실행.
3. 재생성된 스키마 + Swift 모델 커밋.
