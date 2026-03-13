---
summary: TypeBox schemas as the single source of truth for the gateway protocol
read_when:
  - Updating protocol schemas or codegen
title: TypeBox
---

# TypeBox 作為協議的唯一真實來源

最後更新：2026-01-10

TypeBox 是一個以 TypeScript 為主的 schema 函式庫。我們用它來定義 **Gateway WebSocket 協議**（握手、請求/回應、伺服器事件）。這些 schema 驅動了 **執行時驗證**、**JSON Schema 匯出**，以及 macOS 應用的 **Swift 程式碼生成**。唯一的真實來源；其他一切皆由此生成。

如果你想了解更高層次的協議架構，請從 [Gateway 架構](/concepts/architecture) 開始。

## 心智模型（30 秒）

每個 Gateway WS 訊息都是以下三種框架之一：

- **請求**：`{ type: "req", id, method, params }`
- **回應**：`{ type: "res", id, ok, payload | error }`
- **事件**：`{ type: "event", event, payload, seq?, stateVersion? }`

第一個框架 **必須** 是 `connect` 請求。之後，用戶端可以呼叫方法（例如 `health`、`send`、`chat.send`）並訂閱事件（例如 `presence`、`tick`、`agent`）。

連線流程（最簡版）：

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

常用方法與事件：

| 類別 | 範例                                                      | 備註                      |
| ---- | --------------------------------------------------------- | ------------------------- |
| 核心 | `connect`、`health`、`status`                             | `connect` 必須是第一個    |
| 訊息 | `send`、`poll`、`agent`、`agent.wait`                     | 副作用需 `idempotencyKey` |
| 聊天 | `chat.history`、`chat.send`、`chat.abort`、`chat.inject`  | WebChat 使用這些          |
| 會話 | `sessions.list`、`sessions.patch`、`sessions.delete`      | 會話管理                  |
| 節點 | `node.list`、`node.invoke`、`node.pair.*`                 | Gateway WS 與節點操作     |
| 事件 | `tick`、`presence`、`agent`、`chat`、`health`、`shutdown` | 伺服器推送                |

權威清單存放於 `src/gateway/server.ts`（`METHODS`、`EVENTS`）。

## Schema 存放位置

- 原始碼：`src/gateway/protocol/schema.ts`
- 執行時驗證器（AJV）：`src/gateway/protocol/index.ts`
- 伺服器握手與方法調度：`src/gateway/server.ts`
- Node 用戶端：`src/gateway/client.ts`
- 生成的 JSON Schema：`dist/protocol.schema.json`
- 生成的 Swift 模型：`apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## 目前的流程

- `pnpm protocol:gen`
  - 將 JSON Schema (draft‑07) 寫入 `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - 產生 Swift gateway 模型
- `pnpm protocol:check`
  - 執行兩個產生器並驗證輸出已提交

## Schema 在執行時的使用方式

- **伺服器端**：每個進入的 frame 都會用 AJV 驗證。握手階段只接受參數符合 `ConnectParams` 的 `connect` 請求。
- **用戶端**：JS 用戶端在使用事件和回應 frame 前會先驗證它們。
- **方法介面**：Gateway 在 `hello-ok` 中宣告支援的 `methods` 和 `events`。

## 範例 frame

連線（第一則訊息）：

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

Hello-ok 回應：

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

請求 + 回應：

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

事件：

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## 最簡用戶端 (Node.js)

最小可用流程：連線 + 健康檢查。

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

## 實作範例：新增一個端到端的方法

範例：新增一個 `system.echo` 請求，回傳 `{ ok: true, text }`。

1. **Schema（真實資料來源）**

新增至 `src/gateway/protocol/schema.ts`：

ts
export const SystemEchoParamsSchema = Type.Object(
{ text: NonEmptyString },
{ additionalProperties: false },
);

export const SystemEchoResultSchema = Type.Object(
{ ok: Type.Boolean(), text: NonEmptyString },
{ additionalProperties: false },
);

將兩者都加入 `ProtocolSchemas` 並匯出型別：

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **驗證**

在 `src/gateway/protocol/index.ts` 中，匯出一個 AJV 驗證器：

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **伺服器行為**

在 `src/gateway/server-methods/system.ts` 中新增一個處理器：

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

在 `src/gateway/server-methods.ts` 中註冊它（已合併 `systemHandlers`），
然後在 `src/gateway/server.ts` 的 `METHODS` 中加入 `"system.echo"`。

4. **重新產生**

```bash
pnpm protocol:check
```

5. **測試 + 文件**

在 `src/gateway/server.*.test.ts` 中新增一個伺服器測試，並在文件中註明該方法。

## Swift 程式碼生成行為

Swift 產生器會輸出：

- 含有 `req`、`res`、`event` 和 `unknown` 分支的 `GatewayFrame` 列舉
- 強型別的 payload 結構體／列舉
- `ErrorCode` 值與 `GATEWAY_PROTOCOL_VERSION`

未知的 frame 類型會保留為原始 payload，以確保向前相容性。

## 版本控制 + 相容性

- `PROTOCOL_VERSION` 位於 `src/gateway/protocol/schema.ts`。
- 用戶端會傳送 `minProtocol` + `maxProtocol`；伺服器會拒絕不匹配的資料。
- Swift 模型會保留未知的框架類型，以避免破壞舊版用戶端。

## 架構模式與慣例

- 大多數物件使用 `additionalProperties: false` 來定義嚴格的有效載荷。
- `NonEmptyString` 是 ID 以及方法/事件名稱的預設格式。
- 頂層的 `GatewayFrame` 在 `type` 上使用 **區分器**。
- 有副作用的方法通常需要在參數中帶有 `idempotencyKey`
  （範例：`send`、`poll`、`agent`、`chat.send`）。
- `agent` 接受可選的 `internalEvents`，用於執行時產生的協調上下文
  （例如子代理/排程任務完成交接）；此視為內部 API 範圍。

## 即時架構 JSON

產生的 JSON Schema 位於倉庫中的 `dist/protocol.schema.json`。  
發佈的原始檔案通常可在以下位置取得：

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## 當你修改架構時

1. 更新 TypeBox 架構。
2. 執行 `pnpm protocol:check`。
3. 提交重新產生的架構與 Swift 模型。
