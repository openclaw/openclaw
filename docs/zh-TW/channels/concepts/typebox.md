---
summary: TypeBox schemas as the single source of truth for the gateway protocol
read_when:
  - Updating protocol schemas or codegen
title: TypeBox
---

# TypeBox 作為協議的真實來源

最後更新：2026-01-10

TypeBox 是一個以 TypeScript 為主的架構庫。我們使用它來定義 **Gateway WebSocket 協議**（握手、請求/回應、伺服器事件）。這些架構驅動 **執行時驗證**、**JSON Schema 匯出**，以及 macOS 應用程式的 **Swift 程式碼生成**。一個真實來源；其他一切都是自動生成的。

如果您想了解更高層次的協議上下文，請從 [Gateway architecture](/concepts/architecture) 開始。

## Mental model (30 seconds)

每個 Gateway WS 訊息都是三種框架之一：

- **請求**: `{ type: "req", id, method, params }`
- **回應**: `{ type: "res", id, ok, payload | error }`
- **事件**: `{ type: "event", event, payload, seq?, stateVersion? }`

第一個框架 **必須** 是一個 `connect` 請求。之後，用戶端可以調用方法（例如 `health`、`send`、`chat.send`）並訂閱事件（例如 `presence`、`tick`、`agent`）。

[[BLOCK_1]]  
Connection flow (minimal):  
[[INLINE_1]]

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

[[BLOCK_1]]  
常見方法 + 事件:  
[[BLOCK_1]]

| 類別     | 範例                                                      | 備註                        |
| -------- | --------------------------------------------------------- | --------------------------- |
| 核心     | `connect`, `health`, `status`                             | `connect` 必須是第一個      |
| 訊息傳遞 | `send`, `poll`, `agent`, `agent.wait`                     | 副作用需要 `idempotencyKey` |
| 聊天     | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat 使用這些            |
| 會話     | `sessions.list`, `sessions.patch`, `sessions.delete`      | 會話管理員                  |
| 節點     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + 節點操作       |
| 事件     | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | 伺服器推送                  |

權威清單位於 `src/gateway/server.ts` (`METHODS`, `EVENTS`)。

## 架構的位置

- 來源: `src/gateway/protocol/schema.ts`
- 執行時驗證器 (AJV): `src/gateway/protocol/index.ts`
- 伺服器握手 + 方法調度: `src/gateway/server.ts`
- 節點用戶端: `src/gateway/client.ts`
- 生成的 JSON Schema: `dist/protocol.schema.json`
- 生成的 Swift 模型: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Current pipeline

- `pnpm protocol:gen`
  - 將 JSON Schema (draft‑07) 寫入 `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - 生成 Swift 閘道模型
- `pnpm protocol:check`
  - 執行兩個生成器並驗證輸出已被提交

## 架構在執行時的使用方式

- **伺服器端**：每個進來的幀都會使用 AJV 進行驗證。握手僅接受其參數符合 `ConnectParams` 的 `connect` 請求。
- **用戶端**：JS 用戶端在使用事件和回應幀之前會進行驗證。
- **方法介面**：網關在 `hello-ok` 中宣告支援的 `methods` 和 `events`。

## Example frames

[[BLOCK_1]]

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

[[BLOCK_1]]

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

Request + response:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

[[BLOCK_1]]

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## 最小用戶端 (Node.js)

最小有用流程：連接 + 健康檢查。

ts
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

javascript
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

## 實作範例：新增一個方法的端到端流程

範例：新增一個 `system.echo` 請求，返回 `{ ok: true, text }`。

1. **Schema (真實來源)**

`src/gateway/protocol/schema.ts`

ts
export const SystemEchoParamsSchema = Type.Object(
{ text: NonEmptyString },
{ additionalProperties: false },
);

javascript
export const SystemEchoResultSchema = Type.Object(
{ ok: Type.Boolean(), text: NonEmptyString },
{ additionalProperties: false },
);

將兩者都添加到 `ProtocolSchemas` 並導出類型：

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **驗證**

在 `src/gateway/protocol/index.ts` 中，匯出 AJV 驗證器：

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **伺服器行為**

在 `src/gateway/server-methods/system.ts` 中添加一個處理程序：

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

在 `src/gateway/server-methods.ts` 中註冊它（已經合併 `systemHandlers`），然後將 `"system.echo"` 添加到 `METHODS` 中的 `src/gateway/server.ts`。

4. **重新生成**

```bash
pnpm protocol:check
```

5. **測試 + 文件**

在 `src/gateway/server.*.test.ts` 中新增伺服器測試並在文件中註明該方法。

## Swift 程式碼生成行為

Swift 生成器會輸出：

- `GatewayFrame` 列舉型別包含 `req`、`res`、`event` 和 `unknown` 案例
- 強類型的有效載荷結構/列舉型別
- `ErrorCode` 值和 `GATEWAY_PROTOCOL_VERSION`

未知的幀類型將作為原始有效載荷保留，以便向前相容。

## 版本控制 + 相容性

- `PROTOCOL_VERSION` 住在 `src/gateway/protocol/schema.ts`。
- 用戶端發送 `minProtocol` + `maxProtocol`；伺服器會拒絕不匹配的請求。
- Swift 模型保留未知的框架類型，以避免破壞舊版用戶端。

## Schema 樣式與約定

- 大多數物件使用 `additionalProperties: false` 來處理嚴格的有效負載。
- `NonEmptyString` 是 ID 和方法/事件名稱的預設值。
- 最上層的 `GatewayFrame` 在 `type` 上使用 **區分符**。
- 具有副作用的方法通常需要在參數中包含 `idempotencyKey`
  （例如：`send`、`poll`、`agent`、`chat.send`）。
- `agent` 接受可選的 `internalEvents` 以用於執行時生成的編排上下文
  （例如子代理/定時任務完成交接）；將此視為內部 API 接口。

## Live schema JSON

生成的 JSON Schema 位於回購庫的 `dist/protocol.schema.json`。已發布的原始檔案通常可以在以下位置找到：

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## 當你更改架構時

1. 更新 TypeBox 架構。
2. 執行 `pnpm protocol:check`。
3. 提交重新生成的架構 + Swift 模型。
