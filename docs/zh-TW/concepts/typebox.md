---
summary: "TypeBox 結構定義作為 Gateway 通訊協定的單一事實來源"
read_when:
  - 更新通訊協定結構定義或程式碼生成時
title: "TypeBox"
---

# TypeBox 作為通訊協定的單一事實來源

最後更新：2026-01-10

TypeBox 是一個 TypeScript 優先的結構定義（schema）函式庫。我們使用它來定義 **Gateway WebSocket 通訊協定**（交握、請求/回應、伺服器事件）。這些結構定義驅動了**執行階段驗證**、**JSON Schema 匯出**以及 macOS 應用程式的 **Swift 程式碼生成**。這是一個單一事實來源；其餘一切皆由程式產生。

如果您需要更高層級的通訊協定背景資訊，請先閱讀 [Gateway 架構](/concepts/architecture)。

## 心智模型（30 秒）

每則 Gateway WS 訊息都是以下三種訊框之一：

- **請求 (Request)**：`{ type: "req", id, method, params }`
- **回應 (Response)**：`{ type: "res", id, ok, payload | error }`
- **事件 (Event)**：`{ type: "event", event, payload, seq?, stateVersion? }`

第一則訊框**必須**是 `connect` 請求。之後，用戶端可以呼叫方法（例如 `health`、`send`、`chat.send`）並訂閱事件（例如 `presence`、`tick`、`agent`）。

連線流程（簡化）：

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

常見方法 + 事件：

| 類別     | 範例                                                      | 備註                                |
| -------- | --------------------------------------------------------- | ----------------------------------- |
| 核心     | `connect`, `health`, `status`                             | `connect` 必須為首則訊息            |
| 訊息傳遞 | `send`, `poll`, `agent`, `agent.wait`                     | 具副作用的操作需要 `idempotencyKey` |
| 聊天     | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat 使用這些方法                |
| 工作階段 | `sessions.list`, `sessions.patch`, `sessions.delete`      | 工作階段管理                        |
| 節點     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + 節點操作               |
| 事件     | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | 伺服器推送                          |

權威列表位於 `src/gateway/server.ts`（`METHODS`, `EVENTS`）。

## 結構定義檔案位置

- 原始碼：`src/gateway/protocol/schema.ts`
- 執行階段驗證器 (AJV)：`src/gateway/protocol/index.ts`
- 伺服器交握 + 方法分派：`src/gateway/server.ts`
- 節點用戶端：`src/gateway/client.ts`
- 生成的 JSON Schema：`dist/protocol.schema.json`
- 生成的 Swift 模型：`apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## 目前的流程

- `pnpm protocol:gen`
  - 將 JSON Schema (draft‑07) 寫入至 `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - 生成 Swift Gateway 模型
- `pnpm protocol:check`
  - 執行上述兩個產生器，並驗證輸出結果是否已提交至版本控制

## 結構定義如何在執行階段使用

- **伺服器端**：每個入站訊框都會透過 AJV 進行驗證。交握過程僅接受參數符合 `ConnectParams` 的 `connect` 請求。
- **用戶端**：JS 用戶端在運用事件與回應訊框前，會先對其進行驗證。
- **方法介面**：Gateway 會在 `hello-ok` 中宣告支援的 `methods` 與 `events`。

## 訊框範例

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

## 最小用戶端 (Node.js)

最小可用流程：連線 + 健康檢查。

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

## 操作範例：端對端新增一個方法

範例：新增一個 `system.echo` 請求，回傳 `{ ok: true, text }`。

1. **結構定義（單一事實來源）**

新增至 `src/gateway/protocol/schema.ts`：

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

將兩者加入 `ProtocolSchemas` 並匯出型別：

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

在 `src/gateway/server-methods/system.ts` 中新增處理常式：

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

在 `src/gateway/server-methods.ts` 中註冊它（該檔案已合併 `systemHandlers`），然後將 `"system.echo"` 加入至 `src/gateway/server.ts` 中的 `METHODS`。

4. **重新生成**

```bash
pnpm protocol:check
```

5. **測試與文件**

在 `src/gateway/server.*.test.ts` 中加入伺服器測試，並在文件中註記該方法。

## Swift 程式碼生成行為

Swift 產生器會輸出：

- 帶有 `req`, `res`, `event` 及 `unknown` 情況的 `GatewayFrame` 列舉
- 強型別的承載資料（payload）結構體/列舉
- `ErrorCode` 數值與 `GATEWAY_PROTOCOL_VERSION`

未知的訊框類型會保留為原始承載資料，以確保向前相容性。

## 版本控制與相容性

- `PROTOCOL_VERSION` 位於 `src/gateway/protocol/schema.ts`。
- 用戶端發送 `minProtocol` 與 `maxProtocol`；伺服器會拒絕不匹配的請求。
- Swift 模型會保留未知的訊框類型，以避免破壞舊版用戶端。

## 結構定義模式與慣例

- 大多數物件使用 `additionalProperties: false` 以實現嚴格的承載資料驗證。
- `NonEmptyString` 是 ID、方法名稱及事件名稱的預設選擇。
- 最上層的 `GatewayFrame` 在 `type` 上使用**鑑別器 (discriminator)**。
- 具副作用的方法通常需要在參數中包含 `idempotencyKey`（範例：`send`, `poll`, `agent`, `chat.send`）。

## 線上結構定義 JSON

產生的 JSON Schema 位於儲存庫中的 `dist/protocol.schema.json`。發佈的原始檔案通常可在此取得：

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## 當您修改結構定義時

1. 更新 TypeBox 結構定義。
2. 執行 `pnpm protocol:check`。
3. 提交重新生成的結構定義與 Swift 模型。
