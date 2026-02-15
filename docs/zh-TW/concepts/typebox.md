```
---
summary: "TypeBox schemas as the single source of truth for the Gateway 協定"
read_when:
  - 更新協定 schemas 或程式碼產生
title: "TypeBox"
---

# TypeBox 作為協定的單一事實來源

上次更新日期：2026-01-10

TypeBox 是一個 TypeScript 優先的 schema 函式庫。我們用它來定義 **Gateway
WebSocket 協定**（握手、請求/回應、伺服器事件）。這些 schemas
驅動著**執行時驗證**、**JSON Schema 匯出**以及 macOS 應用程式的 **Swift 程式碼產生**。一個單一事實來源；所有其他內容都是產生出來的。

如果您想要更高層次的協定上下文，請從
[Gateway 架構](/concepts/architecture) 開始。

## 心智模型 (30 秒)

每個 Gateway WS 訊息都是以下三種訊框之一：

- **請求**: `{ type: "req", id, method, params }`
- **回應**: `{ type: "res", id, ok, payload | error }`
- **事件**: `{ type: "event", event, payload, seq?, stateVersion? }`

第一個訊框**必須**是 `connect` 請求。之後，客戶端可以呼叫
方法 (例如 `health`, `send`, `chat.send`) 並訂閱事件 (例如
`presence`, `tick`, `agent`)。

連線流程 (最小化):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

常見方法 + 事件:

| 類別      | 範例                                                      | 備註                               |
| --------- | --------------------------------------------------------- | ---------------------------------- |
| 核心      | `connect`, `health`, `status`                             | `connect` 必須是第一個             |
| 訊息傳遞  | `send`, `poll`, `agent`, `agent.wait`                     | 副作用需要 `idempotencyKey`       |
| 聊天      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat 使用這些                  |
| 工作階段  | `sessions.list`, `sessions.patch`, `sessions.delete`      | 工作階段管理                       |
| 節點      | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + 節點動作             |
| 事件      | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | 伺服器推送                         |

權威列表位於 `src/gateway/server.ts` (`METHODS`, `EVENTS`)。

## Schemas 的位置

- 來源: `src/gateway/protocol/schema.ts`
- 執行時驗證器 (AJV): `src/gateway/protocol/index.ts`
- 伺服器握手 + 方法分派: `src/gateway/server.ts`
- 節點客戶端: `src/gateway/client.ts`
- 產生出的 JSON Schema: `dist/protocol.schema.json`
- 產生出的 Swift 模型: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## 目前的流程

- `pnpm protocol:gen`
  - 將 JSON Schema (draft‑07) 寫入 `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - 產生 Swift Gateway 模型
- `pnpm protocol:check`
  - 執行兩個產生器並驗證輸出已提交

## Schemas 在執行時如何被使用

- **伺服器端**: 每個入站訊框都由 AJV 驗證。握手只
  接受 `connect` 請求，其參數與 `ConnectParams` 相符。
- **客戶端**: JS 客戶端在使用事件和回應訊框之前會先進行驗證。
- **方法介面**: Gateway 在 `hello-ok` 中宣告支援的 `methods` 和
  `events`。

## 範例訊框

連線 (第一條訊息):

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

Hello-ok 回應:

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

請求 + 回應:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

事件:

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## 最小客戶端 (Node.js)

最基本有用的流程：連線 + health。

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

## 實際範例：端到端新增方法

範例：新增一個 `system.echo` 請求，返回 `{ ok: true, text }`。

1.  **Schema (單一事實來源)**

新增至 `src/gateway/protocol/schema.ts`:

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

將兩者都新增至 `ProtocolSchemas` 並匯出類型:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2.  **驗證**

在 `src/gateway/protocol/index.ts` 中，匯出一個 AJV 驗證器:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3.  **伺服器行為**

在 `src/gateway/server-methods/system.ts` 中新增一個處理常式:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

在 `src/gateway/server-methods.ts` 中註冊它 (已合併 `systemHandlers`)，
然後將 `"system.echo"` 新增至 `src/gateway/server.ts` 中的 `METHODS`。

4.  **重新產生**

```bash
pnpm protocol:check
```

5.  **測試 + 文件**

在 `src/gateway/server.*.test.ts` 中新增一個伺服器測試，並在文件中記錄該方法。

## Swift 程式碼產生行為

Swift 產生器會發出：

-   包含 `req`、`res`、`event` 和 `unknown` 案例的 `GatewayFrame` 列舉
-   強型別的 payload struct/enum
-   `ErrorCode` 值和 `GATEWAY_PROTOCOL_VERSION`

為了向前相容性，未知訊框類型會保留為原始 payload。

## 版本控制 + 相容性

- `PROTOCOL_VERSION` 位於 `src/gateway/protocol/schema.ts` 中。
- 客戶端傳送 `minProtocol` + `maxProtocol`；伺服器會拒絕不符的連線。
- Swift 模型保留未知訊框類型以避免破壞舊版客戶端。

## Schema 模式和慣例

- 大多數物件使用 `additionalProperties: false` 來實現嚴格的 payload。
- `NonEmptyString` 是 ID 和方法/事件名稱的預設值。
- 頂層的 `GatewayFrame` 在 `type` 上使用**辨別式 (discriminator)**。
- 具有副作用的方法通常需要在參數中包含 `idempotencyKey`
  (範例: `send`, `poll`, `agent`, `chat.send`)。

## 即時 Schema JSON

產生出的 JSON Schema 位於 repository 中的 `dist/protocol.schema.json`。
發布的原始檔案通常可在以下位置取得：

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## 當您更改 schemas 時

1.  更新 TypeBox schemas。
2.  執行 `pnpm protocol:check`。
3.  提交重新產生出的 schema + Swift 模型。
```
