---
summary: "將 TypeBox 結構描述作為 Gateway 通訊協定的單一事實來源"
read_when:
  - 更新通訊協定結構描述或程式碼產生
title: "TypeBox"
---

# TypeBox 作為通訊協定的事實來源

最後更新：2026-01-10

TypeBox 是一個以 TypeScript 為優先的結構描述函式庫。我們使用它來定義 **Gateway
WebSocket 通訊協定**（交握、請求／回應、伺服器事件）。這些結構描述驅動 **執行期驗證**、**JSON Schema 匯出**，以及 macOS 應用程式的 **Swift 程式碼產生**。單一事實來源；其他一切皆由此產生。 35. 我們使用它來定義 **Gateway WebSocket 通訊協定**（交握、請求／回應、伺服器事件）。 36. 這些結構描述驅動**執行階段驗證**、**JSON Schema 匯出**，以及 macOS App 的 **Swift 程式碼產生**。 37. 單一事實來源；其餘一切皆由此產生。

如果你想了解較高層級的通訊協定背景，請從
[Gateway architecture](/concepts/architecture) 開始。

## 心智模型（30 秒）

每個 Gateway WS 訊息都是以下三種框架之一：

- **Request**：`{ type: "req", id, method, params }`
- **Response**：`{ type: "res", id, ok, payload | error }`
- **Event**：`{ type: "event", event, payload, seq?, stateVersion? }`

38. 第一個影格**必須**是 `connect` 請求。 39. 之後，客戶端可以呼叫方法（例如 `health`、`send`、`chat.send`），並訂閱事件（例如 `presence`、`tick`、`agent`）。

連線流程（最小）：

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

常見方法與事件：

| 40. 類別 | 範例                                                    | 注意事項                       |
| ----------------------------- | ----------------------------------------------------- | -------------------------- |
| Core                          | `connect`、`health`、`status`                           | `connect` 必須是第一個           |
| Messaging                     | `send`、`poll`、`agent`、`agent.wait`                    | 有副作用的操作需要 `idempotencyKey` |
| Chat                          | `chat.history`、`chat.send`、`chat.abort`、`chat.inject` | WebChat 使用這些               |
| Sessions                      | `sessions.list`、`sessions.patch`、`sessions.delete`    | session admin              |
| Nodes                         | `node.list`、`node.invoke`、`node.pair.*`               | Gateway WS + 節點動作          |
| Events                        | `tick`、`presence`、`agent`、`chat`、`health`、`shutdown`  | 伺服器推送                      |

權威清單位於 `src/gateway/server.ts`（`METHODS`、`EVENTS`）。

## Where the schemas live

- 來源：`src/gateway/protocol/schema.ts`
- 執行期驗證器（AJV）：`src/gateway/protocol/index.ts`
- 伺服器交握 + 方法分派：`src/gateway/server.ts`
- 節點用戶端：`src/gateway/client.ts`
- 產生的 JSON Schema：`dist/protocol.schema.json`
- 產生的 Swift 模型：`apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## 目前的管線

- `pnpm protocol:gen`
  - 將 JSON Schema（draft‑07）寫入 `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - 產生 Swift Gateway 模型
- `pnpm protocol:check`
  - runs both generators and verifies the output is committed

## 結構描述在執行期的使用方式

- **伺服器端**：每個傳入的框架都會以 AJV 驗證。交握僅接受
  其參數符合 `ConnectParams` 的 `connect` 請求。 The handshake only
  accepts a `connect` request whose params match `ConnectParams`.
- **用戶端**：JS 用戶端在使用事件與回應框架之前會先進行驗證。
- **方法介面**：Gateway 會在 `hello-ok` 中公告支援的 `methods` 與
  `events`。

## 範例框架

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

## 最小用戶端（Node.js）

最小可用流程：連線 + health。

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

## 實作範例：端到端新增一個方法

範例：新增一個 `system.echo` 請求，回傳 `{ ok: true, text }`。

1. **結構描述（事實來源）**

新增到 `src/gateway/protocol/schema.ts`：

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

同時新增到 `ProtocolSchemas` 並匯出型別：

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **驗證**

在 `src/gateway/protocol/index.ts` 中匯出一個 AJV 驗證器：

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **伺服器行為**

在 `src/gateway/server-methods/system.ts` 中新增處理器：

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

在 `src/gateway/server-methods.ts` 中註冊它（已合併 `systemHandlers`），
接著將 `"system.echo"` 加入 `src/gateway/server.ts` 中的 `METHODS`。

4. **重新產生**

```bash
pnpm protocol:check
```

5. **測試 + 文件**

在 `src/gateway/server.*.test.ts` 中新增伺服器測試，並在文件中註明此方法。

## Swift 程式碼產生行為

Swift 產生器會輸出：

- `GatewayFrame` 列舉，包含 `req`、`res`、`event` 與 `unknown` 案例
- 強型別的 payload 結構／列舉
- `ErrorCode` 值與 `GATEWAY_PROTOCOL_VERSION`

未知的框架型別會以原始 payload 保留，以利向前相容。

## Versioning + compatibility

- `PROTOCOL_VERSION` 位於 `src/gateway/protocol/schema.ts`。
- 用戶端會送出 `minProtocol` + `maxProtocol`；伺服器會拒絕不相符者。
- Swift 模型會保留未知的框架型別，以避免破壞較舊的用戶端。

## Schema patterns and conventions

- 多數物件使用 `additionalProperties: false` 以確保 payload 嚴格。
- `NonEmptyString` 是 ID 與方法／事件名稱的預設型別。
- 最上層的 `GatewayFrame` 在 `type` 上使用 **鑑別器**。
- 具有副作用的方法通常需要在參數中提供 `idempotencyKey`
  （例如：`send`、`poll`、`agent`、`chat.send`）。

## 即時結構描述 JSON

產生的 JSON Schema 位於儲存庫中的 `dist/protocol.schema.json`。已發布的原始檔案通常可在以下位置取得： The
published raw file is typically available at:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## When you change schemas

1. 更新 TypeBox 結構描述。
2. 執行 `pnpm protocol:check`。
3. 提交重新產生的結構描述與 Swift 模型。
