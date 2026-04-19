---
summary: "TypeBox 模式作为网关协议的单一事实来源"
read_when:
  - 更新协议模式或代码生成
title: "TypeBox"
---

# TypeBox 作为协议事实来源

最后更新：2026-01-10

TypeBox 是一个 TypeScript 优先的模式库。我们使用它来定义**网关 WebSocket 协议**（握手、请求/响应、服务器事件）。这些模式驱动**运行时验证**、**JSON Schema 导出**和**Swift 代码生成**（用于 macOS 应用）。一个事实来源；其他一切都是生成的。

如果您想要更高级别的协议上下文，请从 [网关架构](/concepts/architecture) 开始。

## 心智模型（30 秒）

每个网关 WS 消息是三种帧之一：

- **请求**：`{ type: "req", id, method, params }`
- **响应**：`{ type: "res", id, ok, payload | error }`
- **事件**：`{ type: "event", event, payload, seq?, stateVersion? }`

第一帧**必须**是 `connect` 请求。之后，客户端可以调用方法（例如 `health`、`send`、`chat.send`）并订阅事件（例如 `presence`、`tick`、`agent`）。

连接流程（最小）：

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ----------->|
  |<---- res:health ----------|
```

常见方法 + 事件：

| 类别     | 示例                                                       | 说明                        |
| -------- | ---------------------------------------------------------- | --------------------------- |
| 核心     | `connect`, `health`, `status`                              | `connect` 必须是第一个      |
| 消息传递 | `send`, `agent`, `agent.wait`, `system-event`, `logs.tail` | 副作用需要 `idempotencyKey` |
| 聊天     | `chat.history`, `chat.send`, `chat.abort`                  | WebChat 使用这些            |
| 会话     | `sessions.list`, `sessions.patch`, `sessions.delete`       | 会话管理                    |
| 自动化   | `wake`, `cron.list`, `cron.run`, `cron.runs`               | 唤醒 + cron 控制            |
| 节点     | `node.list`, `node.invoke`, `node.pair.*`                  | 网关 WS + 节点操作          |
| 事件     | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown`  | 服务器推送                  |

权威的**发现**清单位于 `src/gateway/server-methods-list.ts`（`listGatewayMethods`、`GATEWAY_EVENTS`）。

## 模式所在位置

- 源：`src/gateway/protocol/schema.ts`
- 运行时验证器（AJV）：`src/gateway/protocol/index.ts`
- 广告功能/发现注册表：`src/gateway/server-methods-list.ts`
- 服务器握手 + 方法调度：`src/gateway/server.impl.ts`
- 节点客户端：`src/gateway/client.ts`
- 生成的 JSON Schema：`dist/protocol.schema.json`
- 生成的 Swift 模型：`apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## 当前管道

- `pnpm protocol:gen`
  - 将 JSON Schema（draft‑07）写入 `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - 生成 Swift 网关模型
- `pnpm protocol:check`
  - 运行两个生成器并验证输出已提交

## 模式如何在运行时使用

- **服务器端**：每个入站帧都用 AJV 验证。握手只接受参数匹配 `ConnectParams` 的 `connect` 请求。
- **客户端**：JS 客户端在使用事件和响应帧之前验证它们。
- **功能发现**：网关在 `hello-ok` 中从 `listGatewayMethods()` 和 `GATEWAY_EVENTS` 发送保守的 `features.methods` 和 `features.events` 列表。
- 该发现列表不是 `coreGatewayHandlers` 中每个可调用助手的生成转储；一些助手 RPC 在 `src/gateway/server-methods/*.ts` 中实现，而不在广告功能列表中枚举。

## 示例帧

连接（第一条消息）：

```json
{
  "type": "req",
  "id": "c1",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
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

Hello-ok 响应：

```json
{
  "type": "res",
  "id": "c1",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 3,
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

请求 + 响应：

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

## 最小客户端（Node.js）

最小有用流程：连接 + 健康检查。

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

## 工作示例：端到端添加方法

示例：添加返回 `{ ok: true, text }` 的新 `system.echo` 请求。

1. **模式（事实来源）**

添加到 `src/gateway/protocol/schema.ts`：

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

将两者添加到 `ProtocolSchemas` 并导出类型：

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **验证**

在 `src/gateway/protocol/index.ts` 中，导出 AJV 验证器：

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **服务器行为**

在 `src/gateway/server-methods/system.ts` 中添加处理程序：

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

在 `src/gateway/server-methods.ts` 中注册它（已经合并 `systemHandlers`），然后在 `src/gateway/server-methods-list.ts` 中的 `listGatewayMethods` 输入中添加 `"system.echo"`。

如果该方法可由操作员或节点客户端调用，还请在 `src/gateway/method-scopes.ts` 中对其进行分类，以便范围强制和 `hello-ok` 功能广告保持一致。

4. **重新生成**

```bash
pnpm protocol:check
```

5. **测试 + 文档**

在 `src/gateway/server.*.test.ts` 中添加服务器测试，并在文档中注明该方法。

## Swift 代码生成行为

Swift 生成器发出：

- `GatewayFrame` 枚举，包含 `req`、`res`、`event` 和 `unknown` 情况
- 强类型有效负载结构体/枚举
- `ErrorCode` 值和 `GATEWAY_PROTOCOL_VERSION`

未知帧类型被保留为原始有效负载以实现前向兼容性。

## 版本控制 + 兼容性

- `PROTOCOL_VERSION` 位于 `src/gateway/protocol/schema.ts` 中。
- 客户端发送 `minProtocol` + `maxProtocol`；服务器拒绝不匹配。
- Swift 模型保留未知帧类型以避免破坏旧客户端。

## 模式模式和约定

- 大多数对象使用 `additionalProperties: false` 用于严格的有效负载。
- `NonEmptyString` 是 ID 和方法/事件名称的默认值。
- 顶级 `GatewayFrame` 在 `type` 上使用**鉴别器**。
- 有副作用的方法通常需要参数中的 `idempotencyKey`（例如：`send`、`poll`、`agent`、`chat.send`）。
- `agent` 接受可选的 `internalEvents` 用于运行时生成的编排上下文（例如子代理/cron 任务完成交接）；将其视为内部 API 表面。

## 实时模式 JSON

生成的 JSON Schema 在仓库中的 `dist/protocol.schema.json`。发布的原始文件通常可在以下位置获得：

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## 更改模式时

1. 更新 TypeBox 模式。
2. 在 `src/gateway/server-methods-list.ts` 中注册方法/事件。
3. 当新 RPC 需要操作员或节点范围分类时，更新 `src/gateway/method-scopes.ts`。
4. 运行 `pnpm protocol:check`。
5. 提交重新生成的模式 + Swift 模型。
