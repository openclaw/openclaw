# Control UI 详解

## 概述

Control UI 是 OpenClaw 的 Web 控制面板，用户通过浏览器与 AI Agent 进行对话、管理频道、查看日志和配置系统。它是一个纯前端 SPA，通过 WebSocket 与 Gateway 通信，不直接调用任何 AI Provider。

## 技术栈

| 层级     | 技术                                                                     |
| -------- | ------------------------------------------------------------------------ |
| 框架     | Lit 3.3（Web Components）                                                |
| 状态管理 | TC39 Signals（`signal-polyfill` + `signal-utils` + `@lit-labs/signals`） |
| 构建工具 | Vite 7.3                                                                 |
| 语言     | TypeScript（ESM）                                                        |
| Markdown | marked 17 + DOMPurify                                                    |
| 加密     | @noble/ed25519（设备身份签名）                                           |
| 通信协议 | WebSocket（JSON-RPC 风格）                                               |
| 测试     | Vitest + Playwright（浏览器测试）                                        |
| 部署     | Gateway 内置静态资源服务（构建产物在 `dist/control-ui`）                 |

## 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                    浏览器 (Control UI)                    │
│                                                          │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Lit App  │  │ Chat View    │  │ Tool Stream View  │  │
│  │ 主组件    │  │ 聊天界面      │  │ 工具调用展示        │  │
│  └────┬─────┘  └──────┬───────┘  └────────┬──────────┘  │
│       │               │                    │             │
│  ┌────▼───────────────▼────────────────────▼──────────┐  │
│  │           Controllers (控制器层)                    │  │
│  │  chat.ts / sessions.ts / agents.ts / config.ts     │  │
│  └────────────────────┬───────────────────────────────┘  │
│                       │                                  │
│  ┌────────────────────▼───────────────────────────────┐  │
│  │         GatewayBrowserClient (WebSocket 客户端)     │  │
│  │  连接管理 / 请求-响应 / 事件监听 / 自动重连         │  │
│  └────────────────────┬───────────────────────────────┘  │
│                       │ WebSocket                        │
└───────────────────────┼──────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────┐
│                   Gateway Server                          │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ WS 服务器    │  │ chat.send    │  │ Agent 事件总线   │  │
│  │ 认证/路由    │  │ 消息处理      │  │ 流式广播        │  │
│  └──────┬──────┘  └──────┬───────┘  └────────┬────────┘  │
│         │                │                    │           │
│  ┌──────▼────────────────▼────────────────────▼────────┐  │
│  │              dispatchInboundMessage                   │  │
│  │         → getReplyFromConfig                          │  │
│  │         → runPreparedReply                            │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │                                    │
│  ┌──────────────────────▼────────────────────────────────┐  │
│  │              AI Provider (OpenAI / Anthropic / ...)     │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

## UI 如何调用 AI：完整流程

### 第一阶段：建立连接

1. 浏览器加载 `index.html`，Vite 打包的 JS 注册 `<openclaw-app>` Web Component
2. `OpenClawApp.connectedCallback()` 触发 → `handleConnected()` → `connectGateway()`
3. `GatewayBrowserClient` 创建 WebSocket 连接到 Gateway（默认 `ws://localhost:18789`）
4. Gateway 发送 `connect.challenge` 事件，包含 nonce
5. UI 使用 Ed25519 密钥对签名 nonce，发送 `connect` 请求（含 token、设备身份、角色、权限范围）
6. Gateway 验证通过后返回 `hello` 响应，包含快照数据（频道状态、会话默认值等）
7. UI 收到 `hello` 后标记 `connected = true`，加载聊天历史、Agent 列表、工具目录等

### 第二阶段：发送消息

用户在聊天框输入消息并发送，触发以下链路：

```
用户输入 → handleSendChat() → sendChatMessage() → client.request("chat.send", {...})
```

具体步骤：

1. `handleSendChat()`（`app-chat.ts`）：
   - 检查是否为 stop 命令（`/stop`、`abort` 等），是则调用 `abortChatRun()`
   - 检查是否有正在进行的对话（`isChatBusy`），是则加入队列
   - 清空输入框和附件

2. `sendChatMessage()`（`controllers/chat.ts`）：
   - 构建用户消息内容块（文本 + 图片附件）
   - 立即将用户消息追加到本地 `chatMessages` 数组（乐观更新）
   - 生成 `runId`（UUID），设置 `chatStream = ""`（开始流式状态）
   - 将图片附件转为 base64 格式
   - 通过 WebSocket 发送 `chat.send` RPC 请求

3. 请求参数：
   ```typescript
   {
     sessionKey: "当前会话标识",
     message: "用户输入的文本",
     deliver: false,
     idempotencyKey: runId,  // 幂等键，防止重复
     attachments: [{ type: "image", mimeType: "...", content: "base64..." }]
   }
   ```

### 第三阶段：Gateway 处理消息

Gateway 收到 `chat.send` 请求后（`src/gateway/server-methods/chat.ts`）：

1. 参数校验和消息清理（`sanitizeChatSendMessageInput`）
2. 解析附件（图片转为 `ChatImageContent`）
3. 加载 session 配置和条目
4. 创建 `AbortController`（支持中断）
5. 立即返回 ACK 响应：`{ runId, status: "started" }`（UI 不需要等 AI 回复）
6. 异步调用 `dispatchInboundMessage()`

### 第四阶段：消息路由到 AI

`dispatchInboundMessage()`（`src/auto-reply/dispatch.ts`）→ `dispatchReplyFromConfig()`（`src/auto-reply/reply/dispatch-from-config.ts`）→ `getReplyFromConfig()`（`src/auto-reply/reply/get-reply.ts`）：

1. 解析目标 Agent ID 和模型配置（provider + model）
2. 确保 Agent 工作区存在
3. 处理媒体理解（图片/音频识别）和链接理解
4. 初始化 session 状态（加载历史、处理 `/new` 重置等）
5. 解析指令（thinking level、verbose、model override 等）
6. 调用 `runPreparedReply()`，最终通过配置的 AI Provider（OpenAI、Anthropic、Bedrock 等）发送请求

### 第五阶段：流式响应回传

AI Provider 返回流式响应，通过 Agent 事件总线广播：

1. `createAgentEventHandler()`（`src/gateway/server-chat.ts`）监听 Agent 事件
2. 当收到 `stream: "assistant"` 事件（文本 delta）：
   - 缓存当前文本到 `chatRunState.buffers`
   - 节流控制：每 150ms 最多发送一次 delta
   - 通过 `broadcast("chat", payload)` 广播给所有 WebSocket 客户端
   - payload 格式：`{ runId, sessionKey, state: "delta", message: { role: "assistant", content: [...] } }`

3. 当收到 `stream: "tool"` 事件（工具调用）：
   - 通过 `broadcastToConnIds("agent", toolPayload, recipients)` 发送给注册了 tool-events 能力的客户端

4. 当收到 `lifecycle.end` 事件（完成）：
   - 调用 `emitChatFinal()` 广播最终消息
   - payload 格式：`{ runId, sessionKey, state: "final", message: { role: "assistant", content: [...] } }`

### 第六阶段：UI 渲染响应

UI 的 `GatewayBrowserClient` 收到 WebSocket 事件后：

1. `handleMessage()` 解析 JSON，识别 `type: "event"`
2. 分发到 `handleGatewayEvent()` → `handleGatewayEventUnsafe()`（`app-gateway.ts`）
3. 按事件类型分流：
   - `event: "chat"` → `handleChatGatewayEvent()` → `handleChatEvent()`（`controllers/chat.ts`）：
     - `state: "delta"`：提取文本，更新 `chatStream`（流式文本缓冲）
     - `state: "final"`：将完整消息追加到 `chatMessages`，清除流式状态
     - `state: "aborted"`：保存已流式的部分文本，清除状态
     - `state: "error"`：设置错误信息

   - `event: "agent"` → `handleAgentEvent()`（`app-tool-stream.ts`）：
     - `stream: "tool"`：解析工具调用（名称、参数、输出），维护 `toolStreamById` Map
     - `stream: "compaction"`：处理上下文压缩事件
     - `stream: "lifecycle"`：处理生命周期事件（fallback 等）

4. Lit 的响应式属性变更触发重新渲染，`renderChat()` 将 `chatMessages` + `chatStream` 渲染为聊天气泡

## 关键设计决策

1. UI 不直接调用 AI：所有 AI 交互都通过 Gateway 中转。UI 只是一个 WebSocket 客户端，发送 `chat.send`，接收 `chat` 和 `agent` 事件。

2. 乐观更新 + 流式渲染：用户消息立即显示（不等服务端确认），AI 回复通过 delta 事件实时流式渲染。

3. 事件驱动架构：Gateway 通过 WebSocket 事件广播推送所有状态变更，UI 不需要轮询聊天状态（节点状态和日志使用轮询作为补充）。

4. 设备身份认证：使用 Ed25519 密钥对（存储在 localStorage），每次连接签名 nonce，支持设备级 token 持久化。

5. 节流 delta 广播：Gateway 对流式 delta 做 150ms 节流，避免高频小包冲击 WebSocket。

6. 幂等性保证：每次发送消息携带 `idempotencyKey`（UUID），Gateway 缓存结果防止重复处理。

## 数据流总结

```
用户输入
  │
  ▼
UI: chat.send (WebSocket RPC)
  │
  ▼
Gateway: 参数校验 → ACK → 异步 dispatchInboundMessage
  │
  ▼
auto-reply: getReplyFromConfig → session 管理 → 指令解析
  │
  ▼
AI Provider: OpenAI / Anthropic / Bedrock / Ollama / ...
  │
  ▼ (流式响应)
Gateway: Agent 事件总线 → createAgentEventHandler
  │
  ├─ assistant delta → broadcast("chat", {state:"delta"})  ← 150ms 节流
  ├─ tool events    → broadcastToConnIds("agent", ...)
  └─ lifecycle end  → broadcast("chat", {state:"final"})
  │
  ▼
UI: handleGatewayEvent → handleChatEvent / handleAgentEvent
  │
  ├─ delta → 更新 chatStream（流式文本）
  ├─ final → 追加到 chatMessages（完整消息）
  └─ tool  → 更新 toolStreamById（工具调用卡片）
  │
  ▼
Lit 响应式渲染 → 聊天界面更新
```

## 相关源码路径

### UI 端

| 文件                            | 说明                                    |
| ------------------------------- | --------------------------------------- |
| `ui/index.html`                 | SPA 入口                                |
| `ui/src/main.ts`                | JS 入口（加载样式和 App 组件）          |
| `ui/src/ui/app.ts`              | `<openclaw-app>` 主 Web Component       |
| `ui/src/ui/gateway.ts`          | `GatewayBrowserClient` WebSocket 客户端 |
| `ui/src/ui/app-gateway.ts`      | Gateway 连接管理和事件分发              |
| `ui/src/ui/app-chat.ts`         | 聊天发送/中断/队列逻辑                  |
| `ui/src/ui/app-tool-stream.ts`  | Agent 工具调用事件处理                  |
| `ui/src/ui/app-lifecycle.ts`    | 应用生命周期（连接/断开/更新）          |
| `ui/src/ui/app-polling.ts`      | 节点/日志/调试轮询                      |
| `ui/src/ui/controllers/chat.ts` | 聊天状态管理（发送/历史/事件处理）      |
| `ui/src/ui/device-identity.ts`  | Ed25519 设备身份生成和签名              |
| `ui/src/ui/device-auth.ts`      | 设备认证 token 存储（localStorage）     |
| `ui/src/ui/views/chat.ts`       | 聊天界面渲染                            |
| `ui/src/ui/chat/tool-cards.ts`  | 工具调用卡片渲染                        |
| `ui/src/ui/markdown.ts`         | Markdown 渲染（marked + DOMPurify）     |
| `ui/vite.config.ts`             | Vite 构建配置                           |

### Gateway 端

| 文件                                           | 说明                                      |
| ---------------------------------------------- | ----------------------------------------- |
| `src/gateway/server-methods/chat.ts`           | `chat.send` / `chat.history` 等方法       |
| `src/gateway/server-chat.ts`                   | Agent 事件 → chat 事件广播（delta/final） |
| `src/gateway/control-ui.ts`                    | Control UI 静态资源服务和 SPA fallback    |
| `src/gateway/auth.ts`                          | WebSocket 认证（token/设备/Tailscale）    |
| `src/auto-reply/dispatch.ts`                   | 消息分发入口                              |
| `src/auto-reply/reply/dispatch-from-config.ts` | 消息路由和回复分发                        |
| `src/auto-reply/reply/get-reply.ts`            | AI 回复生成（模型选择/session/指令）      |
