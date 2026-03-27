# OpenClaw Channel Plugin 架构图

## 1. 进程模型

```
┌──────────────────────────────────────────────────────┐
│                  Gateway 进程（单个 Node.js）         │
│                                                      │
│  ┌────────────┐   jiti require   ┌────────────────┐  │
│  │  Gateway   │ ────────────────▶│  Plugin 代码   │  │
│  │  Core      │                  │（直接加载入进程）│  │
│  └────────────┘ ◀──── 函数调用 ──┘                  │
│                                                      │
│  插件不是独立进程，不通过 WebSocket/IPC 通信          │
└──────────────────────────────────────────────────────┘
```

> **关键文件**：`src/plugins/loader.ts:677`
>
> ```ts
> mod = getJiti()(safeSource); // 用 jiti 直接 require 插件 index.ts
> ```

---

## 2. 插件加载流程

```
配置文件 plugins.load.paths
         │
         ▼
  [1] 发现阶段
  src/plugins/discovery.ts
  src/plugins/loader.ts
  扫描目录，找到 openclaw.plugin.json
         │
         ▼
  [2] 加载阶段
  getJiti()(插件入口)
  把插件代码加载进 Gateway 进程
         │
         ▼
  [3] 注册阶段
  plugin.register(api)        ← 插件入口必须 export default { id, register }
  api.registerChannel(...)    ← 注册 Channel
  api.registerTool(...)       ← 可选：注册 Agent 工具
  api.runtime                 ← 注入 PluginRuntime（见第4节）
         │
         ▼
  [4] 启动阶段（Gateway 启动后）
  src/gateway/server-channels.ts
  channelManager.startChannels()
  └─▶ plugin.gateway.startAccount(ctx)   ← 每个账号调用一次
```

**参考实现**（由简到繁）：

| 插件          | 路径                        | 复杂度       | 接入方式         |
| ------------- | --------------------------- | ------------ | ---------------- |
| Synology Chat | `extensions/synology-chat/` | 低（~300行） | Webhook          |
| LINE          | `extensions/line/`          | 中           | Webhook          |
| Feishu        | `extensions/feishu/`        | 高           | WebSocket 长连接 |

---

## 3. ChannelPlugin 接口（必须实现）

> **定义位置**：`src/channels/plugins/types.plugin.ts`、`src/channels/plugins/types.adapters.ts`

```ts
type ChannelPlugin<ResolvedAccount> = {
  // ── 元数据 ──────────────────────────────────────────
  id:           ChannelId           // 唯一标识，如 "feishu"
  meta:         ChannelMeta         // label / docsPath / order
  capabilities: ChannelCapabilities // media / threads / reactions 等
  agentPrompt?: ...                 // 注入 Agent 系统提示词

  // ── 必须实现 ────────────────────────────────────────
  config: {
    listAccountIds():   string[]           // 返回所有已配置账号 ID
    resolveAccount(id): ResolvedAccount    // 从配置解析出账号对象
  }

  // ── 连接生命周期（接收消息） ─────────────────────────
  gateway?: {
    startAccount(ctx): Promise<unknown>    // ★ 建立连接，Promise 保持 pending
    stopAccount(ctx):  Promise<void>       // 优雅断开
    loginAccount?(...): ...               // 扫码登录等流程
    logoutAccount?(...): ...
  }

  // ── 发送消息 ────────────────────────────────────────
  outbound?: {
    deliveryMode: "direct" | "gateway" | "hybrid"
    sendText(ctx):  Promise<OutboundDeliveryResult>  // ★ 发文本
    sendMedia(ctx): Promise<OutboundDeliveryResult>  // 发媒体
    sendPayload(ctx): ...
  }

  // ── 可选 ────────────────────────────────────────────
  pairing?:      ChannelPairingAdapter   // 白名单 / 配对审批
  status?:       ChannelStatusAdapter    // 健康探针 --probe
  configSchema?: ChannelConfigSchema     // UI 表单 Schema
  directory?:    ...                     // 用户目录查询
  messaging?:    ...                     // 消息目标解析
}
```

---

## 4. 消息收发流程

### 4.1 接收消息（外部 → Agent）

```
外部平台（WS 事件 / HTTP Webhook）
         │
         ▼
  plugin.gateway.startAccount(ctx)
  └── 内部循环监听事件（bot.ts / webhook-handler.ts）
         │
         ▼  调用 channelRuntime
  ctx.channelRuntime.reply.finalizeInboundContext()
         │  标准化为统一 InboundContext
         ▼
  ctx.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher()
         │  路由 + 启动 AgentJob
         ▼
  routing.resolveAgentRoute()  →  SessionKey
  src/routing/resolve-route.ts
         │
         ▼
  runEmbeddedPiAgent()  →  Agent 处理
         │
         ▼
  dispatcherOptions.deliver()  →  回调到插件发送回复
```

**关键文件**：`extensions/feishu/src/bot.ts`、`extensions/synology-chat/src/webhook-handler.ts`

---

### 4.2 发送消息（Agent → 外部）

```
Agent 产生回复 payload
         │
         ▼
  src/gateway/server-chat.ts
  格式化 / 分块
         │
         ▼
  plugin.outbound.sendText(ctx)        ← ★ 你实现这里
  └── ctx.to          (目标 chatId)
  └── ctx.text        (消息文本)
  └── ctx.cfg         (账号配置)
         │
         ▼
  调用平台 API 发送
         │
         ▼
  返回 { channel, messageId, chatId }
```

**关键文件**：`extensions/synology-chat/src/channel.ts` → `outbound.sendText`

---

## 5. channelRuntime 注入能力

Gateway 通过 `ctx.channelRuntime` 注入，插件无需自己实现路由/队列/会话逻辑：

| 命名空间   | 主要方法                                                                                        | 说明                      |
| ---------- | ----------------------------------------------------------------------------------------------- | ------------------------- |
| `.reply`   | `dispatchReplyWithBufferedBlockDispatcher`<br>`finalizeInboundContext`<br>`withReplyDispatcher` | 标准化入站 + 路由到 Agent |
| `.routing` | `resolveAgentRoute`<br>`buildAgentSessionKey`                                                   | 路由计算 / SessionKey     |
| `.pairing` | `readAllowFromStore`<br>`upsertPairingRequest`                                                  | 白名单 / 配对             |
| `.session` | `recordInboundSession`<br>`updateLastRoute`                                                     | 会话状态持久化            |
| `.text`    | `chunkMarkdownText`<br>`hasControlCommand`                                                      | 文本分块 / 控制指令       |
| `.media`   | `fetchRemoteMedia`<br>`saveMediaBuffer`                                                         | 媒体下载 / 存储           |
| `.config`  | `loadConfig`<br>`watchConfig`                                                                   | 读取 / 监听配置变化       |

> **定义位置**：`src/plugins/runtime/types-channel.ts`、`src/plugins/runtime/index.ts`

---

## 6. 插件文件结构模板

```
extensions/my-channel/
├── index.ts                  # 入口：export default { id, register(api) }
├── openclaw.plugin.json      # 元数据
├── package.json              # dependencies（不用 workspace:*）
└── src/
    ├── channel.ts            # ★ ChannelPlugin 实现（config/gateway/outbound）
    ├── accounts.ts           # resolveAccount() 逻辑
    ├── types.ts              # ResolvedAccount 类型
    ├── client.ts             # 平台 SDK 封装
    ├── runtime.ts            # getRuntime / setRuntime（PluginRuntimeStore）
    └── webhook-handler.ts    # 或 bot.ts / monitor.ts（处理平台事件）
```

**最简 `index.ts`**：

```ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/my-channel";
import { createMyChannelPlugin } from "./src/channel.js";
import { setMyRuntime } from "./src/runtime.js";

export default {
  id: "my-channel",
  name: "My Channel",
  description: "...",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMyRuntime(api.runtime); // 保存 runtime 供内部使用
    api.registerChannel({ plugin: createMyChannelPlugin() });
  },
};
```

**最简 `channel.ts` 骨架**：

```ts
export function createMyChannelPlugin(): ChannelPlugin<ResolvedAccount> {
  return {
    id: "my-channel",
    meta: { label: "My Channel", ... },
    capabilities: { ... },

    config: {
      listAccountIds: () => Object.keys(loadMyAccounts()),
      resolveAccount: (id) => resolveMyAccount(id),
    },

    gateway: {
      // ★ 保持 Promise pending，直到 abortSignal 触发
      startAccount: async (ctx) => {
        const { cfg, channelRuntime, abortSignal } = ctx;
        // 连接平台、监听消息事件
        platform.on("message", async (msg) => {
          await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
            inboundCtx: channelRuntime.reply.finalizeInboundContext({ ... }),
            dispatcherOptions: {
              deliver: async (text) => { await sendText(cfg, msg.chatId, text); },
            },
          });
        });
        await waitUntilAborted(abortSignal);  // 保持连接
      },
    },

    outbound: {
      deliveryMode: "direct",
      sendText: async (ctx) => {
        await platformApi.sendMessage(ctx.cfg.token, ctx.to, ctx.text);
        return { channel: "my-channel", messageId: "...", chatId: ctx.to };
      },
    },
  };
}
```

---

## 7. 注册到配置

```json
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/my-channel"]
    },
    "entries": {
      "my-channel": { "enabled": true }
    }
  }
}
```

或通过 CLI：

```bash
openclaw plugins add /path/to/my-channel
```

---

## 8. 关键代码位置速查

| 关注点              | 文件路径                                      |
| ------------------- | --------------------------------------------- |
| 插件加载（jiti）    | `src/plugins/loader.ts:677`                   |
| 插件发现            | `src/plugins/discovery.ts`                    |
| Channel 启动入口    | `src/gateway/server-channels.ts:149`          |
| ChannelPlugin 类型  | `src/channels/plugins/types.plugin.ts`        |
| 所有 Adapter 类型   | `src/channels/plugins/types.adapters.ts`      |
| channelRuntime 类型 | `src/plugins/runtime/types-channel.ts`        |
| channelRuntime 实现 | `src/plugins/runtime/index.ts`                |
| 路由计算            | `src/routing/resolve-route.ts`                |
| 消息发送调度        | `src/gateway/server-chat.ts`                  |
| Plugin SDK 导出     | `src/plugin-sdk/`                             |
| 简单插件示例        | `extensions/synology-chat/src/channel.ts`     |
| 完整插件示例        | `extensions/feishu/src/channel.ts` + `bot.ts` |
