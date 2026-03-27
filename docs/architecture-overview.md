# OpenClaw 整体架构图

> 基于 `docs/concepts/architecture.md`、`docs/pi-embedded-runner-architecture.md`、`docs/channel-architecture.md`、`docs/plugin-channel-architecture.md`、`src/gateway/` 及相关源码整理。

---

## 一、组件全景图

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          OPERATOR CLIENTS（控制平面）                             │
│                                                                                  │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────────────────────────────┐   │
│  │   CLI    │   │  macOS App   │   │  Web Chat UI                           │   │
│  │(openclaw │   │  (SwiftUI)   │   │  (由 Gateway HTTP 提供，路径：          │   │
│  │ agent)   │   │              │   │   /__openclaw__/canvas/ & /a2ui/)       │   │
│  └────┬─────┘   └──────┬───────┘   └──────────────┬─────────────────────────┘   │
│       │                │                          │                              │
│       └────────────────┴──────────────────────────┘                              │
│                              WebSocket (ws://127.0.0.1:18789)                    │
│                              role: operator                                      │
└────────────────────────────────────┬────────────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────────────────┐
│                                                                                  │
│                       G A T E W A Y  (核心守护进程)                               │
│                        ws://127.0.0.1:18789  (WS + HTTP 复用同一端口)            │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │  连接层 (ws-connection.ts)                                                │   │
│  │  ├─ 接收帧: { type:"req"|"res"|"event", id, method/event, params/payload }│   │
│  │  ├─ connect 握手 + 设备签名验证 + 配对审批                                 │   │
│  │  └─ 心跳 tick (15s)                                                       │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│  ┌───────────────────┐  ┌───────────────────┐  ┌──────────────────────────────┐ │
│  │  ChannelManager   │  │  AgentHandler     │  │  BroadcastEngine             │ │
│  │                   │  │  (server-chat.ts) │  │  (server-broadcast.ts)       │ │
│  │  管理所有消息通道  │  │  处理 agent RPC   │  │  向所有 WS 客户端广播事件    │ │
│  │  健康检查 & 重连  │  │  路由到 AgentJob  │  │  presence/health/agent/chat  │ │
│  └────────┬──────────┘  └────────┬──────────┘  └──────────────────────────────┘ │
│           │                      │                                               │
│  ┌────────▼──────────┐  ┌────────▼──────────┐  ┌──────────────────────────────┐ │
│  │  Router           │  │  AgentJob Queue   │  │  SessionStore                │ │
│  │  (routing/)       │  │  per-session 串行  │  │  ~/.openclaw/agents/         │ │
│  │  resolve-route.ts │  │  + global lane    │  │  <agentId>/sessions/*.jsonl  │ │
│  │  bindings 解析    │  └───────────────────┘  └──────────────────────────────┘ │
│  └────────┬──────────┘                                                           │
└───────────┼──────────────────────────────────────────────────────────────────────┘
            │                                         ▲
            │ 入站消息                                 │ 出站回复
┌───────────▼──────────────────────────────────────────────────────────────────────┐
│                          CHANNELS（消息通道）                                      │
│                                                                                  │
│  内置通道:                                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ WhatsApp │ │ Telegram │ │ Discord  │ │  Slack   │ │ Signal   │ │ iMessage │ │
│  │(Baileys) │ │(grammY)  │ │          │ │          │ │          │ │          │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
│                                                                                  │
│  扩展插件（Workspace `extensions/*`，另含 LINE / Feishu / Synology Chat 等）:        │
│  MS Teams │ Matrix │ Zalo │ IRC │ Google Chat │ Voice Call │ …                    │
└──────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                             NODE CLIENTS（节点设备）                              │
│                                                                                  │
│  ┌──────────────────────┐   ┌──────────────────────┐                            │
│  │     iOS App          │   │    Android App        │                            │
│  │  caps: camera,       │   │  caps: camera,        │                            │
│  │         canvas,      │   │         canvas,       │                            │
│  │         screen,      │   │         screen,       │                            │
│  │         location     │   │         location      │                            │
│  └──────────┬───────────┘   └──────────┬────────────┘                            │
│             └──────────────────────────┘                                         │
│                    WebSocket (role: node)  ← 同一 Gateway 端口                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、Gateway WebSocket 层

Gateway 的 WebSocket 层在 **同一端口** 上与 HTTP 复用：先创建 HTTP 服务器，再在 `upgrade` 时把连接交给 WebSocket 处理。本节说明该层由哪些模块组成、谁负责收发帧，以及 **如何通过 WebSocket 请求驱动 Agent**。

### 2.1 运行时状态与创建顺序（server-runtime-state.ts）

`createGatewayRuntimeState()` 在 `server.impl.ts` 启动时被调用，负责创建并串联 WebSocket 相关状态：

1. **客户端集合与广播**

- `clients = new Set<GatewayWsClient>()`：所有已握手成功的 WebSocket 客户端。
- `createGatewayBroadcaster({ clients })` → `broadcast` / `broadcastToConnIds`：向 `clients` 中的连接发送 `event` 帧（如 `agent`、`presence`、`tick`）。

2. **HTTP 服务器**

- 为每个监听地址创建 `createGatewayHttpServer(...)`，并传入 `canvasHost`、`clients` 等，用于 HTTP 路由与后续 upgrade 判断。

3. **WebSocket 服务端**

- `wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES })`：不自行监听，由 HTTP 在 `upgrade` 时交给它。
- 对每个已创建的 `httpServer` 调用 `attachGatewayUpgradeHandler({ httpServer, wss, canvasHost, clients, resolvedAuth, rateLimiter })`，在 HTTP 的 `upgrade` 事件里决定是走 Canvas WS、还是 `wss.handleUpgrade` 后 `wss.emit("connection", ws, req)`。

4. **其他运行时状态**

- `agentRunSeq`、`dedupe`、`chatRunState`、`chatAbortControllers`、`toolEventRecipients` 等由 `createGatewayRuntimeState` 一并创建并返回，供后续 **连接处理** 与 **Agent 方法** 使用。

因此：**WebSocket 的“入口”是 HTTP 的 upgrade**，实现在 `server-http.ts` 的 `attachGatewayUpgradeHandler`；**每个逻辑连接** 则由 `server/ws-connection.ts` 和 `server/ws-connection/message-handler.ts` 处理。

### 2.2 主要通信类与职责

| 模块 / 类型                          | 文件                                         | 职责                                                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WebSocketServer**                  | `ws` 库，在 `server-runtime-state.ts` 中创建 | 持有 `noServer: true`，不绑定端口；在 HTTP `upgrade` 时通过 `wss.handleUpgrade` 接管连接并 `emit("connection", ws, req)`。                                                                                  |
| **attachGatewayUpgradeHandler**      | `server-http.ts`                             | 监听 `httpServer.on("upgrade")`：校验/改写 Canvas 作用域 URL、可选走 Canvas WS；否则调用 `wss.handleUpgrade`，将新 `ws` 交给 `wss`，触发后续 `connection`。                                                 |
| **attachGatewayWsConnectionHandler** | `server/ws-connection.ts`                    | 监听 `wss.on("connection", (socket, upgradeReq))`：为每个 socket 分配 `connId`、发送 `connect.challenge`、设置握手超时、注册 `close`/`error`，并调用 **attachGatewayWsMessageHandler** 处理后续消息。       |
| **attachGatewayWsMessageHandler**    | `server/ws-connection/message-handler.ts`    | 注册 `socket.on("message", ...)`：解析 JSON 帧；未握手时只接受 `method:"connect"` 并完成握手（设备/Token 校验、写入 `client`、加入 `clients`）；已握手后校验 `type:"req"` 并调用 **handleGatewayRequest**。 |
| **GatewayWsClient**                  | `server/ws-types.ts`                         | 已握手客户端类型：`{ socket, connect, connId, presenceKey?, clientIp?, canvasHostUrl?, ... }`，存入 `clients` Set，供广播与权限判断。                                                                       |
| **createGatewayBroadcaster**         | `server-broadcast.ts`                        | 根据 `clients` 实现 `broadcast(event, payload)`：按作用域过滤后向所有符合条件的 client 的 `socket.send(JSON.stringify({ type:"event", event, payload, seq, stateVersion }))`。                              |
| **handleGatewayRequest**             | `server-methods.ts`                          | 根据 `req.method` 查找 handler（如 `agent`、`chat.send`、`health` 等），做权限与限流后调用对应 handler，并通过 `respond(ok, payload, error)` 回写 res 帧。                                                  |

握手完成后，**入站请求** 的路径为：  
`socket 收帧` → `message-handler` 解析 req → `handleGatewayRequest` → 具体 method 的 handler（如 `server-methods/agent.ts`）。

**出站推送** 的路径为：  
业务逻辑（如 Agent 事件）→ `broadcast(event, payload)` → 遍历 `clients` 发 `event` 帧。

### 2.3 通过 WebSocket 驱动 Agent 的流程

1. **客户端发起 Agent 请求**

- 客户端发送一帧：`{ type:"req", id:"<unique>", method:"agent", params: { sessionKey, message, idempotencyKey, ... } }`。

2. **服务端接收与分发**

- `message-handler` 在 `socket.on("message")` 中解析 JSON，校验为合法 req 且已握手，则调用 `handleGatewayRequest({ req, respond, client, context })`。
- `server-methods.ts` 中 `coreGatewayHandlers["agent"]` 指向 `server-methods/agent.ts` 的 handler。

3. **Agent 方法内部**

- 校验参数、解析 sessionKey、可做幂等（`context.dedupe.get("agent:" + idempotencyKey)`）；若命中则直接 `respond` 缓存的 res。
- 调用 `registerAgentRunContext(idem, { sessionKey })` 登记 run，便于后续事件带上 sessionKey。
- 调用 **agentCommandFromIngress**（`commands/agent.ts`），内部会入队/执行 `runEmbeddedPiAgent`（或等价入口），即真正跑 Pi 嵌入式 Agent。

4. **Agent 产生事件并回推**

- `runEmbeddedPiAgent` 内部通过 **subscribeEmbeddedPiSession** 等订阅会话流，在 run 过程中调用 **emitAgentEvent**（`infra/agent-events.ts`），发出 `lifecycle`、`assistant`、`tool`、`compaction` 等事件。
- 在 `server.impl.ts` 启动时，会执行 `onAgentEvent(createAgentEventHandler({ broadcast, broadcastToConnIds, nodeSendToSession, agentRunSeq, chatRunState, ... }))`。
- **createAgentEventHandler**（`server-chat.ts`）订阅这些 Agent 事件，对每个事件调用 `broadcast("agent", payload)`（并可能按 sessionKey 做 `broadcastToConnIds`、或转发给 Node、或写入 chat 状态），payload 中包含 `runId`、`stream`、`data` 等。

5. **客户端收到流式结果**

- `broadcast("agent", payload)` 会向所有有权限的 `clients` 发送 `{ type:"event", event:"agent", payload, seq, stateVersion }`。
- CLI / macOS App / Web UI 等通过同一 WebSocket 连接收到这些 event，即可展示 lifecycle、助手文本 delta、工具调用等，实现“通过通信驱动并反馈 Agent”。

总结：**主要通信** 由 **ws-connection.ts（连接与握手）** 和 **message-handler.ts（收帧与调用 handleGatewayRequest）** 完成；**驱动 Agent** 的是 **method:"agent"** 的 RPC，由 **server-methods/agent.ts** 接收并调用 **agentCommandFromIngress → runEmbeddedPiAgent**；**Agent 状态与流式输出** 通过 **emitAgentEvent → onAgentEvent → createAgentEventHandler → broadcast("agent", ...)** 推回所有 WebSocket 客户端。

---

## 三、Agent Runtime 内部结构

```
Gateway AgentHandler
    │  agent RPC (method:"agent", sessionKey, input)
    │
    ▼
AgentJob (enqueue → sessionLane → globalLane)
    │
    ▼
agentCommand()
    ├─ 解析 model + thinking/verbose 默认值
    ├─ 加载 skills 快照
    └─ runEmbeddedPiAgent()
            │
            ▼
    ┌───────────────────────────────────────────────────────────┐
    │  run.ts — runEmbeddedPiAgent()  主重试循环 (while true)   │
    │                                                           │
    │  ┌─────────────────────────────────────────────────────┐  │
    │  │  每次 Attempt: runEmbeddedAttempt() (run/attempt.ts) │  │
    │  │                                                     │  │
    │  │  1. 初始化                                          │  │
    │  │     resolveRunWorkspaceDir → initSandboxInfo        │  │
    │  │     ensureRuntimePluginsLoaded → process.chdir      │  │
    │  │                                                     │  │
    │  │  2. 会话管理                                        │  │
    │  │     ensureSessionManagerCached                      │  │
    │  │     loadSessionHistory (*.jsonl)                    │  │
    │  │                                                     │  │
    │  │  3. Prompt 构建                                     │  │
    │  │     detectAndLoadPromptImages                       │  │
    │  │     before_prompt_build hook                        │  │
    │  │     contextEngine.bootstrap() → assembleSystemPrompt│  │
    │  │                                                     │  │
    │  │  4. Stream 中间件链                                 │  │
    │  │     wrapStreamFnTrimToolCallNames                   │  │
    │  │     wrapStreamFnXaiStreamDecoding                   │  │
    │  │     wrapOllamaCompatNumCtx                          │  │
    │  │     llm_input hook wrapper                         │  │
    │  │                                                     │  │
    │  │  5. 执行 (核心)                                     │  │
    │  │     runPrompt() → LLM API ────────────────────────┐ │  │
    │  │     内部 tool-use 循环                             │ │  │
    │  │       tool_start/update/end 事件                   │ │  │
    │  │       assistant delta 事件                         │ │  │
    │  │                                                    │ │  │
    │  │  6. 压缩 / 超时处理                                │ │  │
    │  │     compactionSafetyTimeout                        │ │  │
    │  │     selectCompactionSnapshot                       │ │  │
    │  │                                                    │ │  │
    │  │  7. 后处理                                         │ │  │
    │  │     contextEngine.afterTurn()                      │ │  │
    │  │     historyImagePrune()                            │ │  │
    │  │     agent_end hook                                 │ │  │
    │  └─────────────────────────────────────────────────────┘  │
    │                                                           │
    │  错误 → 重试决策:                                          │
    │    contextOverflow → compact() → continue                 │
    │    authFailure     → advanceAuthProfile() → continue      │
    │    rateLimitFailure→ backoff + rotate → continue          │
    │    timedOut        → rotate profile → continue            │
    │    success         → buildEmbeddedRunPayloads → return    │
    └───────────────────────────────────────────────────────────┘
            │
            ▼  subscribeEmbeddedPiSession() 桥接事件
    ┌───────────────────────┐
    │  agent 事件流 (广播)   │
    │  stream:"lifecycle"   │  phase: start|end|error
    │  stream:"assistant"   │  text deltas
    │  stream:"tool"        │  tool start/update/end
    └───────────┬───────────┘
                │ BroadcastEngine
                ▼
    所有 WS 客户端 (CLI / macOS App / Web UI)
```

---

## 四、完整数据流

### 4.1 入站消息流（外部用户 → Agent）

Channel **不直接调用** Agent：消息经 **路由** 与 **auto-reply 调度器** 进入执行引擎（详见 `docs/channel-architecture.md`）。

```
外部用户
  │ 在 WhatsApp/Telegram/Discord/... 发送消息
  ▼
ChannelPlugin.gateway.startAccount()（各通道监听：Baileys / grammY / Webhook / …）
  │ 原始事件 → MsgContext / FinalizedMsgContext
  ▼
ChannelManager（server-channels.ts）持有账号生命周期；业务侧常通过 PluginRuntime.reply 收口
  ▼
resolveAgentRoute()（routing/resolve-route.ts）
  │ channel + accountId + peer → bindings / allowFrom
  │ → sessionKey（会话串联）
  ▼
dispatchReplyWithBufferedBlockDispatcher()（auto-reply/reply/provider-dispatcher.ts）
  │ 块级缓冲 + 与 getReply 管线对接；内置/扩展通道走同一入口
  ▼
messages.queue（原 routing.queue，已迁移）
  │ mode: collect | steer | followup | interrupt
  │ debounce: 合并快速连续消息（debounceMs 等，可按通道覆盖）
  ▼
AgentJob → runEmbeddedPiAgent()（见第三节）
  ▼
AgentEvents（infra/agent-events.ts）{ runId, seq, stream, ts, data }
  ▼
BroadcastEngine
  ├─→ WebSocket event:agent → CLI / macOS App / Web UI
  └─→ server-chat.ts → ChannelOutboundAdapter 出站（见 4.2）
```

### 4.2 出站回复流（Agent → 外部用户）

```
AgentRuntime 产生 payloads
  │ [ { text, mediaUrl, isError } ]
  ▼
server-chat.ts
  │ 格式化 + 分割 (textChunkLimit / chunkMode)
  │ Block Streaming: EmbeddedBlockChunker
  │   └─ minChars/maxChars + break preference
  │   └─ code fence 不拆分
  ▼
ChannelOutboundAdapter（sendText / sendMedia / sendPayload 等，通道特定实现）
  ├─ Telegram: sendMessage + editMessageText (preview streaming)
  ├─ Discord:  send + edit draft chunks
  ├─ Slack:    chat.postMessage / chat.startStream
  └─ WhatsApp: 文本 + 媒体分离发送
  ▼
外部用户收到回复
```

### 4.3 直接操控流（CLI/App → Agent）

```
CLI/App
  │ WS req: { type:"req", id, method:"agent",
  │           params:{ sessionKey, input, idempotencyKey } }
  ▼
Gateway
  │ 立即返回 ack:
  │ { type:"res", id, ok:true,
  │   payload:{ runId, status:"accepted" } }
  │
  │ 启动 AgentJob (异步)
  │
  ├──→ WS event: { type:"event", event:"agent",
  │               payload:{ runId, seq:1, stream:"lifecycle",
  │                         data:{ phase:"start" } } }
  │
  ├──→ WS event: { stream:"assistant", data:{ text:"..." } }  (流式)
  │
  ├──→ WS event: { stream:"tool", data:{ toolName, ... } }
  │
  ├──→ WS event: { stream:"lifecycle", data:{ phase:"end" } }
  │
  └──→ WS res (final): { type:"res", id, ok:true,
                         payload:{ runId, status:"ok",
                                   summary:{ inputTokens, outputTokens } } }
```

---

## 五、WebSocket 协议帧格式

```
所有帧均为 UTF-8 JSON 文本帧，协议版本 v3

┌────────────────────────────────────────────────────────────┐
│  REQ (客户端 → Gateway)                                     │
│  { "type": "req",                                          │
│    "id":   "<unique>",                                     │
│    "method": "<method>",                                   │
│    "params": { ... } }                                     │
├────────────────────────────────────────────────────────────┤
│  RES (Gateway → 客户端, 对应 req.id)                        │
│  { "type": "res",                                          │
│    "id":   "<req.id>",                                     │
│    "ok":   true | false,                                   │
│    "payload": { ... } | "error": { code, message } }       │
├────────────────────────────────────────────────────────────┤
│  EVENT (Gateway → 客户端, 主动推送)                          │
│  { "type":  "event",                                       │
│    "event": "<event-name>",                                │
│    "payload": { ... },                                     │
│    "seq":  <number>,             // 单调递增序列号          │
│    "stateVersion": { ... } }     // 可选: presence/health  │
└────────────────────────────────────────────────────────────┘

连接握手规则:
  1. 第一帧必须是 method:"connect"，否则服务端立即关闭连接
  2. connect.params 包含: client(id/version/platform)、role(operator|node)、
     auth(token)、device(id/publicKey/signature/nonce)
  3. Gateway 回复 hello-ok，包含 snapshot(presence+health)、policy、features
  4. 之后可自由发 req 或接收 event
```

---

## 六、关键方法与事件清单

### Gateway RPC 方法

| 方法                       | 方向   | 说明                                              |
| -------------------------- | ------ | ------------------------------------------------- |
| `connect`                  | C→G    | 握手认证，第一帧必须                              |
| `agent`                    | C→G    | 发送消息给 Agent，返回 runId，后续流式 event      |
| `agent.wait`               | C→G    | 等待指定 runId 的 lifecycle end/error（默认 30s） |
| `chat.send`                | C→G    | 直接发送聊天消息                                  |
| `chat.history`             | C→G    | 查询会话历史                                      |
| `chat.inject`              | C→G    | 注入消息（不触发 Agent）                          |
| `chat.abort`               | C→G    | 中止正在运行的 Agent                              |
| `health`                   | C→G    | 查询所有通道健康状态                              |
| `status`                   | C→G    | 查询 Gateway 状态                                 |
| `channels.status`          | C→G    | 通道连接状态                                      |
| `channels.login`           | C→G    | 触发通道登录                                      |
| `channels.logout`          | C→G    | 登出通道                                          |
| `sessions.list`            | C→G    | 列出所有会话                                      |
| `sessions.get`             | C→G    | 获取单个会话详情                                  |
| `sessions.delete`          | C→G    | 删除会话                                          |
| `config.get/set/patch`     | C→G    | 读写 Gateway 配置                                 |
| `cron.list/add/remove/run` | C→G    | 定时任务管理                                      |
| `exec.approval.resolve`    | C→G    | 处理工具执行审批                                  |
| `canvas.navigate`          | G→Node | 控制节点 Canvas 跳转                              |
| `camera.snap`              | G→Node | 触发节点拍照                                      |
| `screen.record`            | G→Node | 触发节点录屏                                      |

### Gateway 推送事件

| 事件                      | 说明                                                |
| ------------------------- | --------------------------------------------------- |
| `presence`                | 在线设备状态变化                                    |
| `health`                  | 通道健康状态变化                                    |
| `tick`                    | 心跳（15s 间隔）                                    |
| `agent`                   | Agent 事件流（lifecycle/assistant/tool/compaction） |
| `chat`                    | 新聊天消息（WebChat 使用）                          |
| `shutdown`                | Gateway 即将关闭                                    |
| `exec.approval.requested` | 工具执行待审批通知                                  |
| `device.pair.requested`   | 新设备配对请求                                      |
| `node.pair.requested`     | 新 Node 配对请求                                    |
| `cron`                    | 定时任务触发事件                                    |

### Agent 事件流 (event:"agent" 内的 stream 字段)

| stream       | data 示例                            | 说明           |
| ------------ | ------------------------------------ | -------------- |
| `lifecycle`  | `{ phase:"start" }`                  | Agent 开始运行 |
| `lifecycle`  | `{ phase:"end", exitCode:0 }`        | Agent 正常结束 |
| `lifecycle`  | `{ phase:"error", error:"..." }`     | Agent 出错     |
| `assistant`  | `{ text:"你好！" }`                  | 助手文字 delta |
| `tool`       | `{ type:"start", toolName, toolId }` | 工具调用开始   |
| `tool`       | `{ type:"update", toolId, data }`    | 工具执行中更新 |
| `tool`       | `{ type:"end", toolId, result }`     | 工具调用结束   |
| `compaction` | `{ compactionId, status }`           | 上下文压缩事件 |

---

## 七、认证与安全

```
连接认证流程:

客户端                                Gateway
  │                                     │
  │── req:connect ──────────────────────►│
  │   params.device.nonce = <challenge>  │  (首次需先获取 challenge event)
  │   params.device.signature = sign(   │
  │     nonce + platform + deviceFamily │
  │   )                                 │
  │   params.auth.token = <token>       │  (若 gateway 配置了 token)
  │                                     │
  │◄─ res:hello-ok ─────────────────────│
  │   payload.snapshot (presence+health)│

作用域 (Operator):
  operator.read      查询类操作
  operator.write     修改类操作
  operator.admin     配置和密钥管理
  operator.approvals 工具执行审批
  operator.pairing   设备配对审批

节点声明 (Node):
  role: "node"
  caps: ["camera", "canvas", "screen", "location"]
  commands: ["camera.snap", "canvas.navigate", "screen.record"]
  permissions: { "screen.record": true }

本地信任:
  环回地址 (127.0.0.1) 或 Gateway 主机 Tailnet 地址 → 可配置自动批准
  远程连接 → 必须显式审批
```

---

## 八、核心设计模式

| 模式                   | 文件                                       | 作用                                                                  |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| **中心化 Gateway**     | `src/gateway/server.impl.ts`               | 单进程持有所有连接和 Channel，无需多进程协调                          |
| **Lane 队列串行化**    | `src/agents/pi-embedded-runner/lanes.ts`   | session 级串行，防止并发写冲突                                        |
| **重试循环**           | `src/agents/pi-embedded-runner/run.ts`     | 统一处理 overflow/auth/rateLimit/timeout，最多 MAX=32~160 次          |
| **Auth Profile 轮转**  | `src/agents/auth-profiles.ts`              | 多账号负载均衡 + cooldown 跳过                                        |
| **Stream 中间件链**    | `run/attempt.ts`                           | 工具名规范化、provider 特定解码（xAI/Ollama）                         |
| **Plugin Hook 系统**   | `hook-runner-global.ts`                    | before_model_resolve / before_prompt_build / llm_input / agent_end    |
| **Context Engine**     | `src/context-engine/`                      | bootstrap → assemble → afterTurn 生命周期                             |
| **自动 Compaction**    | `src/agents/pi-embedded-runner/compact.ts` | 溢出时压缩历史，最多 3 次，保留 token 预算                            |
| **幂等性键**           | `ws-connection.ts` dedupe cache            | `send`/`agent` 请求可安全重试                                         |
| **Block Streaming**    | `EmbeddedBlockChunker`                     | 分块发送，code fence 不拆分，支持 coalesce 合并                       |
| **ChannelPlugin 契约** | `src/channels/plugins/types.plugin.ts`     | 内置与扩展通道统一结构类型：config / gateway / outbound / pairing / … |
| **入站回复调度**       | `auto-reply/reply/provider-dispatcher.ts`  | `dispatchReplyWithBufferedBlockDispatcher` 统一接入路由与 Agent 管线  |
| **插件同进程加载**     | `src/plugins/loader.ts`                    | jiti 加载 `openclaw.plugin.json`，`registerChannel` 注入注册表        |
| **协议 Codegen**       | `apps/macos/Sources/OpenClawProtocol/`     | TypeBox → JSON Schema → Swift 模型自动生成                            |

---

## 九、关键源文件索引

| 文件                                                      | 职责                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/gateway/server.impl.ts`                              | Gateway 启动、主循环、WebSocket + HTTP 服务器                                           |
| `src/gateway/server-runtime-state.ts`                     | 创建 wss、clients、broadcast、HTTP 服务器并挂载 upgrade 与 WS 连接                      |
| `src/gateway/server-http.ts`                              | HTTP 服务器创建、attachGatewayUpgradeHandler（upgrade 时交给 wss 或 Canvas WS）         |
| `src/gateway/server/ws-connection.ts`                     | wss.on("connection")：每连接发 challenge、注册 message 与 close、调用 message-handler   |
| `src/gateway/server/ws-connection/message-handler.ts`     | socket.on("message")：解析 req、握手与 method 分发、调用 handleGatewayRequest           |
| `src/gateway/server/ws-types.ts`                          | GatewayWsClient 类型（socket、connect、connId 等）                                      |
| `src/gateway/server-ws-runtime.ts`                        | attachGatewayWsHandlers：将 broadcast、context 等注入 ws-connection 层                  |
| `src/gateway/server-broadcast.ts`                         | createGatewayBroadcaster：向 clients 广播 event 帧                                      |
| `src/gateway/server-chat.ts`                              | createAgentEventHandler：订阅 Agent 事件并 broadcast；Agent 事件 → 通道出站             |
| `src/gateway/server-methods.ts`                           | handleGatewayRequest：按 method 分发到各 handler（agent、chat、health 等）              |
| `src/gateway/server-methods/agent.ts`                     | method:"agent" 的 handler：校验、幂等、registerAgentRunContext、agentCommandFromIngress |
| `src/gateway/server-channels.ts`                          | ChannelManager 创建和健康监控                                                           |
| `src/gateway/protocol/schema/frames.ts`                   | 协议帧 TypeBox Schema 定义                                                              |
| `src/channels/registry.ts`                                | 通道注册表和元数据                                                                      |
| `src/channels/plugins/types.plugin.ts`                    | `ChannelPlugin` 与 adapters 类型定义                                                    |
| `src/auto-reply/reply/provider-dispatcher.ts`             | `dispatchReplyWithBufferedBlockDispatcher`：入站 → Agent 的统一调度入口                 |
| `src/plugins/loader.ts`                                   | 插件发现、jiti 加载、`api.registerChannel` 注册                                         |
| `src/routing/resolve-route.ts`                            | 入站消息路由解析                                                                        |
| `src/routing/bindings.ts`                                 | Channel → Agent 绑定配置                                                                |
| `src/infra/agent-events.ts`                               | Agent 事件系统（AgentEventPayload 类型）                                                |
| `src/agents/pi-embedded-runner/run.ts`                    | 主入口：重试循环、认证管理                                                              |
| `src/agents/pi-embedded-runner/run/attempt.ts`            | 单次 Attempt 完整生命周期                                                               |
| `src/agents/pi-embedded-runner/lanes.ts`                  | Lane 队列名解析                                                                         |
| `src/agents/pi-embedded-runner/compact.ts`                | 上下文压缩逻辑                                                                          |
| `src/agents/pi-embedded-runner/tool-result-truncation.ts` | 工具结果截断                                                                            |
| `src/context-engine/index.ts`                             | 上下文引擎生命周期 API                                                                  |
| `src/agents/auth-profiles.ts`                             | Auth Profile 轮转与 cooldown                                                            |
| `docs/concepts/architecture.md`                           | Gateway 官方架构文档                                                                    |
| `docs/channel-architecture.md`                            | Channel 适配器、`ChannelPlugin`、Routing 与 dispatcher 数据流                           |
| `docs/plugin-channel-architecture.md`                     | 插件进程模型、加载流程与 `registerChannel`                                              |
| `docs/concepts/agent-loop.md`                             | Agent Loop 官方文档                                                                     |
| `docs/concepts/streaming.md`                              | 流式输出官方文档                                                                        |

## 十、Lane 队列详解

### 10.1 什么是 Lane？

```typescript
// src/agents/pi-embedded-runner/lanes.ts
Lane =
  "session:<sessionKey>" | // sessionLane，例如 "session:agent:123:whatsapp:+86138xxxx"
  "main" | // globalLane，全局主队列
  "compaction" | // 压缩专用
  "system"; // 系统任务
```

**Lane 就是一个队列的名字**，用来把任务分类，让同类型的任务串行执行，避免并发冲突。

---

### 10.2 为什么需要 Lane？（解决并发写冲突）

**场景**：同一个 WhatsApp 会话，用户连续发送 3 条消息：

```
用户: "查天气"
用户: "讲个笑话"  (1秒后)
用户: "我是谁"    (2秒后)
```

**问题**：如果这 3 条消息同时触发 3 个 Agent 任务：

```
Agent-1: 读取会话历史 [] → 调用 LLM → 写回复 "天气是..."
Agent-2: 读取会话历史 [] → 调用 LLM → 写回复 "笑话是..."
Agent-3: 读取会话历史 [] → 调用 LLM → 写回复 "你是..."
```

**结果**：

- Agent-1 读到 `[]`，写入后历史为 `["天气是..."]`
- Agent-2 读到 `[]`（覆盖了 Agent-1 的结果），写入后历史为 `["笑话是..."]`
- Agent-3 读到 `[]`（覆盖了之前所有），写入后历史为 `["你是..."]`

**数据丢失！艹！**

---

### 10.3 Lane 如何解决？（Session 级串行化）

```typescript
// src/agents/pi-embedded-runner/run.ts:257-262

// 1. 解析 Session Lane
const sessionLane = resolveSessionLane(params.sessionKey);
// 结果: "session:agent:123:whatsapp:+86138xxxx"

// 2. 创建闭包，固定 Lane 名称
const enqueueSession = (task, opts) =>
  enqueueCommandInLane(sessionLane, task, opts);

// 3. 所有任务使用同一个 Lane
await enqueueSession(() => runEmbeddedAttempt({...}))  // task1
await enqueueSession(() => runEmbeddedAttempt({...}))  // task2
await enqueueSession(() => runEmbeddedAttempt({...}))  // task3
```

**执行流程**：

```
Task1: 读取 [] → LLM → 写入 ["天气是..."] → 完成
Task2: 读取 ["天气是..."] → LLM → 写入 ["天气是...", "笑话是..."] → 完成
Task3: 读取 ["天气是...", "笑话是..."] → LLM → 写入 ["天气是...", "笑话是...", "你是..."] → 完成
```

**数据完整性保住了！** ✅

---

### 10.4 Lane 队列实现

```typescript
// src/process/command-queue.ts:43-50

type LaneState = {
  lane: string; // Lane 名称
  queue: QueueEntry[]; // 待执行队列
  activeTaskIds: Set<number>; // 正在执行的任务
  maxConcurrent: number; // 最大并发 (默认 1)
  draining: boolean; // 是否正在排空
  generation: number; // 世代号 (防旧任务干扰)
};

// 所有 Lane 的全局存储
const lanes = new Map<string, LaneState>();
```

**核心逻辑**：

```typescript
// 1. 入队
function enqueueCommandInLane(lane: string, task: () => Promise<T>): Promise<T> {
  const state = getLaneState(lane); // 获取或创建 Lane

  return new Promise((resolve, reject) => {
    state.queue.push({ task, resolve, reject, enqueuedAt: Date.now() });
    drainLane(lane); // 触发执行
  });
}

// 2. 执行 (串行)
function drainLane(lane: string) {
  const state = getLaneState(lane);

  // 如果已有任务在执行，直接返回
  if (state.activeTaskIds.size >= state.maxConcurrent) return;

  // 如果队列空了，直接返回
  if (state.queue.length === 0) return;

  // 取出下一个任务
  const entry = state.queue.shift();
  const taskId = nextTaskId++;

  // 标记为执行中
  state.activeTaskIds.add(taskId);

  // 执行任务
  entry.task().then((result) => {
    state.activeTaskIds.delete(taskId); // 标记完成
    entry.resolve(result);
    drainLane(lane); // 递归执行下一个
  });
}
```

---

### 10.5 Lane 的类型和使用场景

| Lane 类型        | 名称格式                               | 使用场景            | 并发数 |
| ---------------- | -------------------------------------- | ------------------- | ------ |
| **Session Lane** | `session:<agentId>:<channel>:<peerId>` | Agent 任务执行      | 1      |
| **Global Main**  | `main`                                 | Cron 任务、系统任务 | 可配置 |
| **Compaction**   | `compaction`                           | 上下文压缩          | 1      |
| **System**       | `system`                               | 心跳、清理任务      | 可配置 |
| **Auth Probe**   | `auth-probe:`\*                        | 认证探针            | 1      |

**示例**：

```typescript
// Session Lane (Agent 执行任务)
await enqueueSession(() => agentCommand("天气", sessionKey));
// Lane: "session:agent:123:whatsapp:+8613800138000"

// Global Lane (Cron 任务)
await enqueueCommandInLane("main", () => cronJob());
// Lane: "main"

// System Lane (心跳)
await enqueueCommandInLane("system", () => heartbeat());
// Lane: "system"
```

---

### 10.6 Lane 与 JavaScript 事件循环的区别

```typescript
// ❌ 错误：依赖 JS 事件循环 (并发执行)
await Promise.all([
  agentCommand("task1"), // 同时开始
  agentCommand("task2"), // 同时开始
  agentCommand("task3"), // 同时开始
]);
// 结果：数据竞争，顺序不确定

// ✅ 正确：Lane 队列 (串行执行)
await enqueueSession(() => agentCommand("task1")); // 完成...
await enqueueSession(() => agentCommand("task2")); // 再开始...
await enqueueSession(() => agentCommand("task3")); // 再开始
// 结果：顺序确定，数据安全
```

| 特性         | JS Event Loop   | Lane 队列     |
| ------------ | --------------- | ------------- |
| **执行顺序** | 不确定 (并发)   | 确定 (串行)   |
| **数据安全** | 需手动加锁      | 天然安全      |
| **适用场景** | I/O 并行        | 会话级操作    |
| **复杂度**   | 高 (需处理竞态) | 低 (自动排队) |

---

### 10.7 Lane 的性能影响

```
3 个任务：
- 并发模式: 总时间 ≈ max(task1, task2, task3) ~ 5s
  问题: 数据竞争，结果不可靠

- 串行模式 (Lane): 总时间 = task1 + task2 + task3 ~ 15s
  优势: 数据安全，结果可靠
```

**虽然慢了 3 倍，但数据不丢，值！**

---

### 10.8 Lane 的附加功能

#### 1. **优雅重启 (Draining)**

```typescript
// Gateway 重启前，标记所有 Lane 为 draining
markGatewayDraining();

// 新任务入队时直接拒绝
if (gatewayDraining) {
  return Promise.reject(new GatewayDrainingError());
}

// 等待正在执行的任务完成
await waitForActiveTasks();
```

#### 2. **超时警告**

```typescript
enqueueSession(task, {
  warnAfterMs: 2000, // 等待超过 2 秒警告
  onWait: (waitMs, queuedAhead) => {
    console.warn(`任务已等待 ${waitMs}ms，前面还有 ${queuedAhead} 个任务`);
  },
});
```

#### 3. **队列统计**

```typescript
// 查看队列长度
getQueueSize("session:agent:123"); // 返回: 5

// 查看所有 Lane 的总队列长度
getTotalQueueSize(); // 返回: 42
```

---

### 10.9 核心代码位置

- `**src/process/command-queue.ts**` - Lane 队列核心实现 (229行)
- `**src/process/lanes.ts**` - Lane 类型定义
- `**src/agents/pi-embedded-runner/lanes.ts**` - Session Lane 解析
- `**src/agents/pi-embedded-runner/run.ts:257-262**` - enqueueSession 闭包创建
- `**src/agents/pi-embedded-runner/run.ts:681-800**` - 重试循环中使用 Lane

---

## 十一、CLI 的完整作用

### 11.1 CLI 不仅仅是 Gateway 启动器

```bash
❯ openclaw --help

gateway          # Gateway 管理 (运行、状态、发现、调用)
agent            # 直接运行 Agent (无需 Gateway)
channels         # 频道管理 (WhatsApp/Telegram/Discord等)
cron             # 定时任务管理
daemon           # 守护进程管理 (launchd/systemd/schtasks)
config           # 配置管理
plugins          # 插件管理
sessions         # 会话管理
devices          # 设备配对管理
exec-approvals   # 工具执行审批
memory           # 记忆管理
models           # 模型管理
skills           # 技能管理
webhooks         # Webhook 管理
status           # 系统状态
health           # 健康检查
logs             # 日志管理
update           # 更新管理
install          # 安装管理
completion       # Shell 补全
doctor           # 诊断工具
```

**CLI 是 OpenClaw 的完整用户界面 + 系统管理工具 + 调试工具！**

---

### 11.2 CLI 的五大核心作用

#### 1. Gateway 生命周期管理 ✅

```bash
# 运行 Gateway
openclaw gateway run --bind 127.0.0.1 --port 18789

# 查看状态
openclaw gateway status --probe

# 发现局域网网关
openclaw gateway discover --timeout 2000

# 直接调用 RPC
openclaw gateway call health --params '{"detailed":true}'
openclaw gateway call agent --params '{"sessionKey":"...", "message":"Hello"}'

# 查询使用成本
openclaw gateway usage-cost --days 30
```

**作用**：启动、监控、调试 Gateway，与 Gateway 通过 WebSocket RPC 通信。

---

#### 2. 系统服务管理 (Daemon) ✅

```bash
# 安装为系统服务 (支持 launchd/systemd/schtasks)
openclaw daemon install
openclaw daemon install --user  # 用户级服务
openclaw daemon install --system # 系统级服务

# 服务生命周期
openclaw daemon start    # 启动
openclaw daemon stop     # 停止
openclaw daemon restart  # 重启
openclaw daemon status   # 查看状态
openclaw daemon uninstall # 卸载

# 不同平台示例
# macOS: 创建 ~/Library/LaunchAgents/ai.openclaw.gateway.plist
# Linux: 创建 /etc/systemd/system/openclaw-gateway.service
# Windows: 创建 Scheduled Task
```

**作用**：将 Gateway 安装为后台服务，开机自启动，进程守护。

---

#### 3. 配置管理 ✅

```bash
# 读取配置
openclaw config get gateway.bind          # 查看绑定地址
openclaw config get channels.whatsapp     # 查看 WhatsApp 配置
openclaw config get model                 # 查看模型配置

# 修改配置
openclaw config set gateway.bind 0.0.0.0
openclaw config set model.provider openai
openclaw config set model.id gpt-4o

# 批量配置
openclaw config patch config.json

# 配置路径
# ~/.openclaw/config.json (默认)
# 格式: JSON，支持嵌套
```

**作用**：读取和修改 Gateway 配置，支持热加载。

---

#### 4. 运行时控制 ✅

```bash
# 直接运行 Agent (无需 Gateway，快速测试)
openclaw agent --message "Hello" --thinking medium
openclaw agent --file prompt.txt --model gpt-4o

# 频道管理
openclaw channels status                    # 查看所有频道状态
openclaw channels login whatsapp           # WhatsApp QR 码登录
openclaw channels logout telegram          # Telegram 登出
openclaw channels send whatsapp:+86138xxxx --message "Hi"

# 会话管理
openclaw sessions list                      # 列出所有会话
openclaw sessions get agent:123:whatsapp:+86138xxxx
openclaw sessions delete agent:123          # 删除会话

# 记忆管理
openclaw memory search "项目计划"           # 搜索记忆
openclaw memory export --format json       # 导出记忆
openclaw memory stats                      # 记忆统计

# 插件管理
openclaw plugins list                       # 列出插件
openclaw plugins install @openclaw/msteams  # 安装插件
openclaw plugins remove msteams            # 移除插件

# 工具审批
openclaw exec-approvals list               # 待审批列表
openclaw exec-approvals approve <id>       # 批准
openclaw exec-approvals deny <id>          # 拒绝
```

**作用**：运行时操控 Agent、频道、会话、插件等。

---

#### 5. 开发调试 ✅

```bash
# 诊断工具
openclaw doctor                              # 全面诊断
openclaw doctor --fix                        # 自动修复问题

# 日志查看
openclaw logs --follow                       # 实时日志
openclaw logs --level error                  # 只看错误
openclaw logs --grep "agent"                 # 过滤 Agent 日志

# 性能分析
openclaw gateway health                      # Gateway 健康
openclaw channels status --probe            # 频道健康探测
openclaw status --deep                      # 深度状态

# 调试模式
VERBOSE=1 openclaw gateway run              # 详细日志
OPENCLAW_WS_LOG=verbose openclaw gateway run # WebSocket 帧日志

# 查看源码
openclaw docs architecture                  # 查看架构文档
```

**作用**：问题诊断、日志分析、性能调优。

---

### 11.3 CLI 与 Gateway 的职责划分

| 维度         | CLI (客户端)               | Gateway (服务器)           |
| ------------ | -------------------------- | -------------------------- |
| **进程类型** | 短期进程 (执行完退出)      | 长期进程 (持续运行)        |
| **进程数**   | 多个 (每个命令一个)        | 单进程 (端口复用)          |
| **主要作用** | 用户界面、命令解析         | WebSocket 服务器、频道管理 |
| **通信方式** | WebSocket 客户端 → Gateway | WebSocket 服务器 ← 客户端  |
| **存储**     | 无 (临时进程)              | 会话历史、配置、配对信息   |
| **重启策略** | 无需重启                   | 支持热重启、系统服务       |
| **并发模型** | 单用户单命令               | 多客户端并发               |
| **配置加载** | 只读配置                   | 读写配置 + 热加载          |
| **日志输出** | stdout/stderr              | 文件 + stdout + WebSocket  |

**关系图**：

```
CLI 进程 (--message)
    │  WebSocket RPC
    │  ws://127.0.0.1:18789
    ▼
Gateway 进程 (长期运行)
    ├─ 接收 WS 请求
    ├─ enqueueSession (Lane 队列)
    ├─ 执行 Agent
    ├─ broadcast agent 事件
    └─ 写会话历史 (文件)

CLI 进程 (接收事件)
    │  WebSocket event
    ▼
打印 assistant delta / tool 输出
```

---

### 11.4 CLI 技术实现

```typescript
// src/cli/program/index.ts (CLI 入口)

program
  .command("agent")
  .description("直接运行 Agent")
  .option("--message <msg>", "输入消息")
  .option("--model <model>", "模型 ID")
  .action(async (opts) => {
    // 1. 创建 WebSocket 客户端
    const ws = new WebSocket("ws://127.0.0.1:18789");

    // 2. 发送 connect 帧
    ws.send(JSON.stringify({
      type: "req",
      id: uuid(),
      method: "connect",
      params: { role: "operator", device: {...} }
    }));

    // 3. 发送 agent 请求
    ws.send(JSON.stringify({
      type: "req",
      id: uuid(),
      method: "agent",
      params: { sessionKey, message: opts.message }
    }));

    // 4. 接收 agent 事件流
    ws.on("message", (frame) => {
      const { type, event, payload } = JSON.parse(frame);
      if (type === "event" && event === "agent") {
        if (payload.stream === "assistant") {
          process.stdout.write(payload.data.text);  // 流式输出
        }
      }
    });
  });
```

**关键技术**：

- **Commander.js**：命令解析框架
- **WebSocket 客户端**：与 Gateway 通信
- **事件流处理**：实时显示 Agent 输出
- **进度条**：@clack/prompts + osc-progress
- **终端样式**：colors + 表格 + ANSI 转义

---

## 十二、src 包结构详解

### 12.1 完整目录结构

```
src/
├── agents/              # 517个文件 🔥Agent 运行时 (核心)
│   ├── pi-embedded-runner/     # Pi 嵌入式 Agent
│   │   ├── run.ts              # 主入口 (重试循环)
│   │   ├── run/attempt.ts      # 单次执行完整生命周期
│   │   ├── run/payloads.ts     # 结果构建
│   │   ├── compact.ts          # 上下文压缩
│   │   └── lanes.ts            # Lane 队列名解析
│   ├── skills/                 # 技能系统
│   │   ├── registry.ts         # 技能注册表
│   │   ├── loader.ts           # 技能加载
│   │   └── runtime.ts          # 技能运行时
│   ├── system-prompt.ts        # 系统提示词模板
│   ├── auth-profiles.ts        # 认证 Profile 轮转
│   └── context-window-guard.ts # 上下文窗口守卫
│
├── gateway/             # 238个文件 🔥Gateway 服务器 (核心)
│   ├── server.impl.ts          # Gateway 启动 (主循环)
│   ├── server-runtime-state.ts # 运行时状态
│   ├── server-http.ts          # HTTP 服务器
│   ├── server-ws-connection/   # WebSocket 连接层
│   │   ├── ws-connection.ts    # 连接管理
│   │   └── message-handler.ts  # 消息处理器
│   ├── server-methods/         # RPC 方法实现
│   │   ├── agent.ts            # method: agent
│   │   ├── chat.ts             # method: chat.*
│   │   ├── health.ts           # method: health
│   │   └── ...
│   ├── server-broadcast.ts     # 广播引擎
│   ├── server-chat.ts          # Agent 事件处理器
│   └── protocol/               # 协议定义
│       └── schema/frames.ts    # 帧格式定义
│
├── cli/                 # 288个文件 🔥CLI 命令行 (用户入口)
│   ├── gateway-cli/            # Gateway 相关命令
│   │   ├── run.ts              # gateway run
│   │   ├── register.ts         # 注册所有命令
│   │   ├── call.ts             # gateway call
│   │   └── discover.ts         # gateway discover
│   ├── daemon-cli/             # 守护进程命令
│   │   ├── install.ts          # daemon install
│   │   ├── lifecycle.ts        # start/stop/restart
│   │   └── status.ts
│   ├── channels-cli.ts         # channels 命令
│   ├── agent.ts                # agent 命令
│   ├── config-cli.ts           # config 命令
│   ├── plugins-cli.ts          # plugins 命令
│   └── program/                # CLI 框架
│
├── channels/            # 65个文件 消息频道驱动
│   ├── whatsapp/           # WhatsApp
│   ├── telegram/           # Telegram
│   ├── discord/            # Discord
│   ├── slack/              # Slack
│   ├── signal/             # Signal
│   └── imessage/           # iMessage
│
├── infra/               # 300个文件 基础设施
│   ├── agent-events.ts     # Agent 事件系统
│   ├── heartbeat-runner.ts # 心跳
│   ├── restart.ts          # 重启机制
│   ├── ports.ts            # 端口占用检测
│   └── ...
│
├── config/              # 207个文件 配置管理
│   ├── config.ts           # 主配置
│   ├── sessions.ts         # 会话配置
│   └── types.secrets.ts    # 密钥类型
│
├── process/             # 17个文件 进程管理 🔥核心
│   ├── command-queue.ts    # Lane 队列核心实现
│   ├── lanes.ts            # Lane 类型定义
│   └── restart-recovery.ts # 重启恢复
│
├── context-engine/      # 8个文件 上下文引擎 🔥核心
│   ├── index.ts            # 引擎入口
│   ├── compact.ts          # 压缩逻辑
│   └── assemble.ts         # 提示词组装
│
├── routing/             # 13个文件 消息路由 🔥核心
│   ├── resolve-route.ts    # 路由解析
│   ├── bindings.ts         # 频道绑定配置
│   └── session-key.ts      # 会话 Key 解析
│
├── sessions/            # 14个文件 会话管理
│   ├── session-manager.ts  # 会话管理器
│   ├── history.ts          # 历史记录读写
│   └── cost-usage.ts       # 成本统计
│
├── cron/                # 72个文件 定时任务
├── secrets/             # 47个文件 密钥管理
├── plugins/             # 68个文件 插件系统
├── browser/             # 135个文件 浏览器自动化
├── media/               # 42个文件 媒体处理
├── memory/              # 98个文件 记忆系统
├── tui/                 # 33个文件 终端 UI
├── utils/               # 31个文件 工具函数
└── telegram/            # 127个文件 Telegram 实现
└── discord/             # 60个文件 Discord 实现
└── slack/               # 60个文件 Slack 实现
└── whatsapp/            # 42个文件 WhatsApp 实现
└── line/                # 45个文件 Line 实现
└── ...                  # 其他频道实现
```

---

#### **1. `src/agents/` - Agent Runtime (517个文件)**

**职责**：Agent 的大脑，负责与 LLM 交互、工具调用、上下文管理。

**核心算法**：

- **重试循环** (`run.ts`): while(true) 统一处理 overflow/auth/rateLimit/timeout
- **Lane 队列** (`lanes.ts`): session 级串行化，防并发写冲突
- **Profile 轮转** (`auth-profiles.ts`): 多账号负载均衡 + cooldown 跳过
- **自动压缩** (`compact.ts`): 上下文溢出时压缩历史，保留 token 预算

---

#### **2. `src/gateway/` - Gateway Server (238个文件)**

**职责**：中央 WebSocket 服务器，管理连接、路由消息、广播事件。

**核心设计**：

- **中心化**: 单进程持有所有连接和 Channel，无需多进程协调
- **HTTP/WS 复用**: 同一端口 (18789) 同时提供 HTTP 和 WebSocket
- **事件驱动**: BroadcastEngine 向所有 WS 客户端推送事件
- **协议类型安全**: TypeBox 定义帧格式，自动生成 JSON Schema

---

### 12.3 包依赖关系

```
cli (288个文件, 用户入口)
  │  WebSocket RPC
  │  ws://127.0.0.1:18789
  ▼
gateway (238个文件, WebSocket 服务器)
  │  enqueueSession / enqueueGlobal
  │  Lane 队列串行化
  ▼
agents (517个文件, Agent 运行时)
  │  contextEngine.bootstrap()
  │  contextEngine.assembleSystemPrompt()
  ▼
context-engine (8个文件, 上下文管理)
  │  读写会话历史
  ▼
sessions (14个文件, 会话存储)
  │  ~/.openclaw/agents/<id>/sessions/*.jsonl
  └─ channels (65个文件)
     └─ routing (13个文件, 消息路由)
```

**依赖关系说明**：

1. **cli** 依赖 **gateway**: CLI 通过 WebSocket RPC 调用 Gateway 方法
2. **gateway** 依赖 **agents**: Gateway 调用 Agent 执行任务
3. **agents** 依赖 **context-engine**: Agent 使用上下文引擎管理会话
4. **context-engine** 依赖 **sessions**: 上下文引擎读写会话历史
5. **gateway** 依赖 **channels**: Gateway 通过 Channel 收发消息
6. **gateway** 依赖 **routing**: Gateway 使用 Router 解析消息路由
7. **channels** + **routing** + **auto-reply**: 入站消息经 `resolveAgentRoute` 与 `dispatchReplyWithBufferedBlockDispatcher` 进入 Agent（见 4.1）

---

## 十三、总结

### OpenClaw 架构核心

1. **单进程 Gateway**: 所有组件跑在一个 Node.js 进程里，省得进程间通信麻烦
2. **WebSocket 统一协议**: 所有客户端都用一套协议，省得搞多种通信方式
3. **Lane 队列**: session 级串行化，避免并发写冲突
4. **重试循环**: 自动处理各种失败场景，不用人工干预
5. **CLI 不只是启动器**: 完整的用户界面 + 系统管理工具 + 调试工具

### 三个核心组件

- **agents/** (517个文件): Agent 大脑，与 LLM 交互
- **gateway/** (238个文件): WebSocket 服务器，消息路由
- **cli/** (288个文件): 用户界面，命令行工具

### 通信三板斧

- **WebSocket** (主要): 所有客户端 ↔ Gateway
- **内存共享** (进程内): Gateway 内部组件通信
- **文件系统** (持久化): 会话历史、配置、配对信息

### 一句话总结

**OpenClaw 是一个单进程架构的 AI Agent 网关，通过 WebSocket 统一协议连接 CLI、App、Web UI 和 Node 客户端，使用 Lane 队列实现会话级串行化，确保数据安全。**

---

## X、进程模型与 CLI 的双重角色

### X.1 一个可执行文件，两种进程身份

OpenClaw 使用同一个 `openclaw` 可执行文件启动**两种完全不同的进程**：

#### 1. Gateway 服务器进程

```bash
# 启动命令
$ openclaw gateway run --bind 127.0.0.1 --port 18789

# 进程特征
- 进程类型: **WebSocket 服务端**
- 启动方式: CLI 命令启动
- 生命周期: **永久运行** (不主动退出)
- 职责: 监听端口、处理请求、管理状态
- 端口: 监听 18789 (WebSocket + HTTP)
- 代码位置: `src/gateway/server.impl.ts`
```

**启动流程**：

```typescript
// 用户输入: openclaw gateway run
// Shell 启动 Node.js 进程 (PID: 12345)

1. 加载 CLI 代码 (src/cli/)
2. 解析命令: gateway run
3. 调用 startGatewayServer()  // ← 在这里创建服务器
4. 创建 HTTP + WebSocket 服务器
5. 绑定端口 18789
6. 进入事件循环 runGatewayLoop()
7. **进程身份转换**: 从 CLI 变成 Gateway
8. **持续运行**, 等待 WebSocket 连接
```

#### 2. CLI 客户端进程

```bash
# 查询命令
$ openclaw gateway health

# 进程特征
- 进程类型: **WebSocket 客户端**
- 启动方式: CLI 命令启动
- 生命周期: **临时运行** (执行完立即退出)
- 职责: 发送请求、接收响应、打印输出
- 端口: **不监听任何端口**
- 代码位置: `src/gateway/client.ts`
```

**执行流程**：

```typescript
// 用户输入: openclaw gateway health
// Shell 启动 Node.js 进程 (PID: 67890)

1. 加载 CLI 代码 (src/cli/)
2. 解析命令: gateway health
3. 创建 GatewayClient  // ← WebSocket 客户端
4. 连接到 ws://127.0.0.1:18789
5. 发送 req:health
6. 等待 res:health
7. 打印结果到 stdout
8. **进程退出** (PID: 67890 结束)
```

---

### X.2 进程生命周期对比

| 命令                           | 进程类型       | 启动 Gateway  | WebSocket 连接       | 执行完     | 典型 PID     |
| ------------------------------ | -------------- | ------------- | -------------------- | ---------- | ------------ |
| `openclaw gateway run`         | **启动命令**   | ✅ 创建服务器 | ❌ 不连接 (自己就是) | **不退出** | 12345 (长期) |
| `openclaw gateway call health` | **查询命令**   | ❌ 不启动     | ✅ 连接 PID 12345    | **退出**   | 67890 (临时) |
| `openclaw agent --message`     | **Agent 命令** | ❌ 不启动     | ✅ 连接 PID 12345    | **退出**   | 54321 (临时) |
| `openclaw channels status`     | **状态命令**   | ❌ 不启动     | ✅ 连接 PID 12345    | **退出**   | 98765 (临时) |

**关键理解**：

- **两个完全独立的进程** (PID 12345 ≠ PID 67890)
- 第二个进程通过 **WebSocket** 连接到第一个进程
- 不是同一个进程同时担任客户端和服务端

---

### X.3 实际运行示例

````bash
# === 终端 1: 启动 Gateway === #
$ openclaw gateway run
# → Shell 启动 Node.js 进程
# → 进程 PID: 12345
# → 加载 CLI 代码
# → 解析命令: gateway run
# → 调用 startGatewayServer()
# → 创建 WebSocket 服务器
# → 监听 ws://127.0.0.1:18789
# → 输出: Gateway listening on ws://127.0.0.1:18789
# → 进入事件循环 (进程不退出)
#
# 现在 PID 12345 是 Gateway 服务器进程
# 等待 WebSocket 连接...

# === 终端 2: 查询健康状态 === #
$ openclaw gateway health
# → Shell 启动新 Node.js 进程
# → 进程 PID: 67890 (完全不同的进程)
# → 加载 CLI 代码
# → 解析命令: gateway health
# → 创建 GatewayClient (WebSocket 客户端)
# → 连接到 ws://127.0.0.1:18789 (PID 12345)
# → 发送: {type:
## X、进程模型与 CLI 的双重角色

### X.1 一个可执行文件，两种进程身份

OpenClaw 使用同一个 `openclaw` 可执行文件启动**两种完全不同的进程**：

#### 1. Gateway 服务器进程

```bash
# 启动命令
$ openclaw gateway run --bind 127.0.0.1 --port 18789

# 进程特征
- 进程类型: **WebSocket 服务端**
- 启动方式: CLI 命令启动
- 生命周期: **永久运行** (不主动退出)
- 职责: 监听端口、处理请求、管理状态
- 端口: 监听 18789 (WebSocket + HTTP)
- 代码位置: `src/gateway/server.impl.ts`
````

**启动流程**：

```typescript
// 用户输入: openclaw gateway run
// Shell 启动 Node.js 进程 (PID: 12345)

1. 加载 CLI 代码 (src/cli/)
2. 解析命令: gateway run
3. 调用 startGatewayServer()  // ← 在这里创建服务器
4. 创建 HTTP + WebSocket 服务器
5. 绑定端口 18789
6. 进入事件循环 runGatewayLoop()
7. **进程身份转换**: 从 CLI 变成 Gateway
8. **持续运行**, 等待 WebSocket 连接
```

#### 2. CLI 客户端进程

```bash
# 查询命令
$ openclaw gateway health

# 进程特征
- 进程类型: **WebSocket 客户端**
- 启动方式: CLI 命令启动
- 生命周期: **临时运行** (执行完立即退出)
- 职责: 发送请求、接收响应、打印输出
- 端口: **不监听任何端口**
- 代码位置: `src/gateway/client.ts`
```

**执行流程**：

```typescript
// 用户输入: openclaw gateway health
// Shell 启动 Node.js 进程 (PID: 67890)

1. 加载 CLI 代码 (src/cli/)
2. 解析命令: gateway health
3. 创建 GatewayClient  // ← WebSocket 客户端
4. 连接到 ws://127.0.0.1:18789
5. 发送 req:health
6. 等待 res:health
7. 打印结果到 stdout
8. **进程退出** (PID: 67890 结束)
```

---

### X.2 进程生命周期对比

| 命令                           | 进程类型       | 启动 Gateway  | WebSocket 连接       | 执行完     | 典型 PID     |
| ------------------------------ | -------------- | ------------- | -------------------- | ---------- | ------------ |
| `openclaw gateway run`         | **启动命令**   | ✅ 创建服务器 | ❌ 不连接 (自己就是) | **不退出** | 12345 (长期) |
| `openclaw gateway call health` | **查询命令**   | ❌ 不启动     | ✅ 连接 PID 12345    | **退出**   | 67890 (临时) |
| `openclaw agent --message`     | **Agent 命令** | ❌ 不启动     | ✅ 连接 PID 12345    | **退出**   | 54321 (临时) |
| `openclaw channels status`     | **状态命令**   | ❌ 不启动     | ✅ 连接 PID 12345    | **退出**   | 98765 (临时) |

**关键理解**：

- **两个完全独立的进程** (PID 12345 ≠ PID 67890)
- 第二个进程通过 **WebSocket** 连接到第一个进程
- 不是同一个进程同时担任客户端和服务端

---

### X.3 实际运行示例

```bash
# === 终端 1: 启动 Gateway === #
$ openclaw gateway run
# → Shell 启动 Node.js 进程
# → 进程 PID: 12345
# → 加载 CLI 代码
# → 解析命令: gateway run
# → 调用 startGatewayServer()
# → 创建 WebSocket 服务器
# → 监听 ws://127.0.0.1:18789
# → 输出: Gateway listening on ws://127.0.0.1:18789
# → 进入事件循环 (进程不退出)
#
# 现在 PID 12345 是 Gateway 服务器进程
# 等待 WebSocket 连接...

# === 终端 2: 查询健康状态 === #
$ openclaw gateway health
# → Shell 启动新 Node.js 进程
# → 进程 PID: 67890 (完全不同的进程)
# → 加载 CLI 代码
# → 解析命令: gateway health
# → 创建 GatewayClient (WebSocket 客户端)
# → 连接到 ws://127.0.0.1:18789 (PID 12345)
# → 发送: {type:"req", id:"1", method:"health"}
# → 等待响应...
# → 收到: {type:"res", id:"1", ok:true, payload:{status:"ok"}}
# → 打印: {status:"ok"}
# → 进程退出 (PID: 67890 结束)

# === 终端 2: 运行 Agent === #
$ openclaw agent --message "Hello"
# → Shell 启动新 Node.js 进程
# → 进程 PID: 54321 (又一个新进程)
# → 加载 CLI 代码
# → 解析命令: agent
# → 创建 GatewayClient
# → 连接到 ws://127.0.0.1:18789 (PID 12345)
# → 发送: {type:"req", id:"2", method:"agent", params:{message:"Hello"}}
# → 收到流式事件: assistant delta, tool, lifecycle
# → 打印: Hello! How can I help?
# → 进程退出 (PID: 54321 结束)

# === 终端 1: Gateway 仍在运行 === #
# PID: 12345 (持续运行)
# 可以继续接受连接...
```

---

### X.4 代码层面的进程分支

```typescript
// src/cli/program/index.ts

// 分支 1: Gateway 服务器 (不退出)
program.command("gateway run").action(async (opts) => {
  const server = await startGatewayServer(opts);
  await runGatewayLoop({ start: () => server }); // ← 无限循环，不退出
});

// 分支 2: CLI 客户端 (执行完退出)
program.command("gateway call <method>").action(async (method, opts) => {
  const result = await callGateway({ method }); // ← WebSocket 连接
  console.log(result);
  process.exit(0); // ← 主动退出
});

program.command("agent").action(async (opts) => {
  const result = await callGateway({ method: "agent" }); // ← WebSocket 连接
  console.log(result);
  process.exit(0); // ← 主动退出
});
```

**关键区别**:

- `gateway run`: **不调用 process.exit()**, 进程持续运行
- `gateway call/agent`: **主动调用 process.exit()**, 进程结束

---

### X.5 为什么这样设计？

#### 1. 单一职责原则 ✅

```typescript
// Gateway 进程: 只做服务器的事
const server = new WebSocketServer({ port: 18789 });
server.on("connection", handleClient);
// 职责: 接受连接、处理请求、管理状态
// 生命周期: 永久

// CLI 进程: 只做客户端的事
const client = new WebSocket("ws://127.0.0.1:18789");
client.send(reqFrame);
// 职责: 发送请求、接收响应、打印输出
// 生命周期: 临时
```

**好处**: 每个进程职责清晰，代码好维护。

---

#### 2. 进程隔离 ✅

```bash
# 如果 CLI 崩溃了
$ openclaw agent --message "Hello"
# 错误: 语法错误，进程崩溃
# PID: 54321 退出 (不影响 Gateway)

# Gateway 完全不受影响
$ ps aux | grep openclaw
# PID 12345 openclaw gateway  # ← 还在运行！
```

**好处**: CLI 查询崩溃，不影响 Gateway；Gateway 稳定运行。

---

#### 3. 网络透明 ✅

```typescript
// 本地开发
openclaw gateway health
// → WebSocket 连接到 ws://127.0.0.1:18789
// → 开发体验好，延迟低

// 远程生产
openclaw gateway health --url wss://prod.example.com
// → WebSocket 连接到 wss://prod.example.com
// → 同一套代码，无需修改

// 甚至是 SSH 隧道
ssh -N -L 18789:prod:18789 user@prod
openclaw gateway health
// → WebSocket 连接到 ws://127.0.0.1:18789
// → 但实际访问的是生产环境
```

**好处**: 开发/测试/生产环境使用同一套代码，支持远程管理。

---

#### 4. 热加载 ✅

```bash
# 启动 Gateway (第一次)
$ openclaw gateway run
# PID: 12345

# 修改配置
$ openclaw config set model.id gpt-4o

# 热加载配置 (不重启 Gateway)
$ openclaw gateway call reload
# → WebSocket 发送 req:reload
# → Gateway 重新加载配置
# → PID: 12345 继续运行

# Gateway 不需要重启
```

**好处**: 配置热加载，服务不中断。

---

#### 5. 架构统一 ✅

```typescript
// 所有通信都用 WebSocket，协议一致

// CLI → WebSocket → Gateway
// macOS App → WebSocket → Gateway
// Web UI → WebSocket → Gateway
// Node 客户端 → WebSocket → Gateway
// ACP Bridge → WebSocket → Gateway

// 代码复用率高
// 只需要一个 GatewayClient 类
// 所有客户端都用它
```

**好处**: 协议统一，代码复用，测试容易。

---

### X.6 与 MySQL 的类比

OpenClaw 的设计和 MySQL 一模一样：

```bash
# MySQL 服务器进程 (长期运行)
$ mysqld --port 3306
# PID: 11111
# 身份: TCP 服务器
# 职责: 监听 3306 端口，处理 SQL 查询

# MySQL 客户端进程 (临时运行)
$ mysql -u root -p
# PID: 22222
# 身份: TCP 客户端
# 职责: 连接到 3306，发送 SQL，打印结果，退出

# 另一个客户端
$ mysql -u root -p -e "SELECT * FROM users"
# PID: 33333
# 身份: TCP 客户端
# 职责: 连接、查询、打印、退出
```

vs

```bash
# OpenClaw Gateway 服务器进程 (长期运行)
$ openclaw gateway run
# PID: 12345
# 身份: WebSocket 服务器
# 职责: 监听 18789 端口，处理 Agent 请求

# OpenClaw CLI 客户端进程 (临时运行)
$ openclaw gateway health
# PID: 67890
# 身份: WebSocket 客户端
# 职责: 连接到 18789，发送请求，打印结果，退出

# 另一个客户端
$ openclaw agent --message "Hi"
# PID: 54321
# 身份: WebSocket 客户端
# 职责: 连接、发送、接收、退出
```

---

### X.7 ACP Bridge 组件

```bash
# ACP Bridge 是一个特殊的 Gateway 客户端
# 它提供 ACP (Agent Control Protocol) 服务

$ openclaw acp --token <token>
# 启动 ACP 服务器 (长期运行)
# 监听 ACP 连接 (默认端口 3333)
# 桥接 ACP ↔ WebSocket → Gateway

# 外部工具 (如 Claude Desktop) 可以连接到 ACP
# 而不需要直接实现 WebSocket 协议
```

**架构位置**:

```
┌────────────────────────────────────────────────────────────┐
│                  ACP BRIDGE (可选组件)                      │
│                                                            │
│  ┌──────────┐          ┌─────────────────────────┐        │
│  │  Claude  │          │  ACP Server           │        │
│  │ Desktop  │──ACP───▶ │  (openclaw acp)       │        │
│  └──────────┘          │                       │        │
│                        └──────────┬────────────┘        │
└───────────────────────────────────┼─────────────────────┘
                                    │ WebSocket
┌───────────────────────────────────▼─────────────────────┐
│                    Gateway (PID: 12345)                 │
│              (WebSocket Server, 端口 18789)            │
└─────────────────────────────────────────────────────────┘
```

---

### X.8 macOS App 通信方式

**macOS App** 是用 **SwiftUI** 编写的原生 macOS 应用程序。

**通信方式**: **WebSocket** (和 CLI 一样) ✅

```swift
// macOS App 源码 (简化)
let ws = WebSocket(url: URL(string: "ws://127.0.0.1:18789")!)
ws.send(JSON.stringify([
    "type": "req",
    "method": "connect",
    "params": ["role": "operator"]
]))
```

**特点**:

- 原生 SwiftUI 应用
- 菜单栏常驻 (Menubar)
- 开机自启动 (LaunchAgent)
- 自动重连机制
- 支持 Canvas 控制、会话管理、配置页面

**在架构图中的位置**:

```
┌────────────────────────────────────────────────────────────┐
│              OPERATOR CLIENTS (控制平面)                  │
│                                                            │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │   CLI    │  │  macOS App   │  │   Web Chat UI   │    │
│  │(openclaw│  │  (SwiftUI)   │  │  (HTTP + WS)    │    │
│  │command)  │  │              │  │                 │    │
│  └────┬─────┘  └──────┬───────┘  └─────────┬───────┘    │
│       │               │                    │            │
│       └───────────────┴────────────────────┘            │
│                       WebSocket (ws://127.0.0.1:18789)  │
│                       role: operator                    │
└──────────────────────────────┬──────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────┐
│                    Gateway (PID: 12345)                 │
│              (WebSocket Server, 端口 18789)            │
└─────────────────────────────────────────────────────────┘
```

---

### X.9 设计总结

```
一个可执行文件 (openclaw)
    ├── 命令: gateway run
    │   └── 进程身份: WebSocket 服务端 (PID: 12345)
    │       └── 生命周期: 永久运行
    │       └── 职责: 监听端口、处理请求
    │
    ├── 命令: gateway call / agent / channels / ...
    │   └── 进程身份: WebSocket 客户端 (PID: 67890, 54321, ...)
    │       └── 生命周期: 临时运行
    │       └── 职责: 发送请求、接收响应
    │       └── 连接目标: ws://127.0.0.1:18789 (PID: 12345)
    │
    └── 意义:
        ├── 单一职责: 每个进程只做一件事
        ├── 进程隔离: CLI 崩溃不影响 Gateway
        ├── 网络透明: 支持本地和远程访问
        ├── 架构统一: 所有客户端都用 WebSocket
        └── 符合 Unix 哲学: 小工具组合
```

---

### X.10 常见误解澄清

**❌ 错误理解**: CLI 既当客户端又当服务端 (同一个进程)

**✅ 正确理解**:

- `openclaw gateway run` → **启动一个进程 (PID:12345) 作为服务端**
- `openclaw `\* → **启动另一个进程 (PID:67890) 作为客户端**
- **两个完全独立的进程**, 客户端通过 WebSocket 连接服务端

**类比**:

- `mysqld` 启动 MySQL 服务器进程
- `mysql` 启动 MySQL 客户端进程
- **两个进程**, 客户端通过 TCP 连接服务器

---

## 一、组件全景图 (修正版)

> **重要更新**: 明确了 CLI 通过 WebSocket 与 Gateway 通信，添加了 ACP Bridge 组件，macOS App 通信方式说明。

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                      OPERATOR CLIENTS / ACP / NODE                           │
│                                                                              │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐  ┌────────────────┐ │
│  │    CLI     │  │  macOS App   │  │   Web Chat UI   │  │  ACP Bridge    │ │
│  │ (openclaw │  │  (SwiftUI)   │  │  (HTTP + WS)    │  │  (openclaw acp)│ │
│  │  command)  │  │              │  │                 │  │                │ │
│  └─────┬──────┘  └──────┬───────┘  └─────────┬───────┘  └─────────┬──────┘ │
│        │                │                    │                    │        │
│        └────────────────┴────────────────────┴────────────────────┘        │
│                          WebSocket (ws://127.0.0.1:18789)                  │
│                          role: operator (CLI/App/WebUI)                    │
│                          role: acp-bridge (ACP)                            │
│                          role: node (iOS/Android)                          │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────────────┐
│                                                                              │
│                            G A T E W A Y                                    │
│                    (Node.js 单进程，ws://127.0.0.1:18789)                    │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  WebSocket 连接层 (ws-connection.ts)                                   │ │
│  │  ├─ HTTP upgrade → WebSocket                                           │ │
│  │  ├─ connect 握手 (device signature + auth token)                       │ │
│  │  └─ 心跳 tick (15s)                                                    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌──────────────┐  ┌─────────────────┐  ┌──────────────────────────────┐   │
│  │ Channel      │  │ AgentHandler    │  │ BroadcastEngine              │   │
│  │ Manager      │  │ (server-chat.ts)│  │ (server-broadcast.ts)        │   │
│  └──────┬───────┘  └────────┬────────┘  └──────────────┬───────────────┘   │
│         │                   │                         │                     │
│         ▼                   ▼                         ▼                     │
│  ┌─────────────┐      ┌──────────┐          ┌─────────────────┐          │
│  │ WhatsApp    │      │ AgentJob │          │ SessionStore    │          │
│  │ Telegram    │      │ (Lane)   │          │ (jsonl)         │          │
│  │ Discord     │      └──────────┘          └─────────────────┘          │
│  │ Slack       │                                                          │
│  └─────────────┘                                                          │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 通信方式说明

| 组件                   | 通信协议  | 角色       | 说明                                               |
| ---------------------- | --------- | ---------- | -------------------------------------------------- |
| **CLI**                | WebSocket | operator   | 命令行工具，通过 WS 调用 Gateway RPC [详见第 X 章] |
| **macOS App**          | WebSocket | operator   | SwiftUI 原生应用，菜单栏常驻 [详见第 X.8 节]       |
| **Web Chat UI**        | WebSocket | operator   | 浏览器中的 UI，通过 WS 与 Gateway 通信             |
| **ACP Bridge**         | WebSocket | acp-bridge | 桥接 ACP 协议 ↔ WebSocket → Gateway                |
| **Node (iOS/Android)** | WebSocket | node       | 设备节点，caps: camera/screen/canvas               |

**重要提示**:

1. **CLI 不是直接调用函数**，而是通过 **WebSocket** 连接到 Gateway 进程 (PID: 12345)[详见第 X 章]
2. **macOS App** 也是通过 **WebSocket** 通信，不是特殊的 native IPC
3. **ACP Bridge** 是一个特殊的 Gateway 客户端，它监听 ACP 连接并桥接到 WebSocket
4. 控制面客户端通常为 `operator`；**ACP Bridge** 为 `acp-bridge`；**Node**（iOS/Android 等）为 `node`

---
