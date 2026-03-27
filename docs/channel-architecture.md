# OpenClaw Channel 架构文档

## 概述

你的猜想**基本正确**，但实现比想象的更精细：

> **Channel 的本质**：Channel 是一个"适配器集合对象"（`ChannelPlugin`），负责对接第三方通信平台（Telegram、Discord、Slack、iMessage 等）。每个 Channel 将外部平台的消息标准化后送入路由层，最终由 Agent 处理；Agent 的回复再经 Channel 的出站适配器发回给第三方平台。

关键点：Channel **不直接通信 Agent**，而是通过 **路由层（routing）** 和 **自动回复调度器（auto-reply dispatcher）** 间接调用 Agent。

---

## 一、核心数据结构

### 1.1 `ChannelPlugin` — Channel 的唯一契约

所有 Channel（内置 + 第三方扩展）都必须实现并导出一个 `ChannelPlugin` 对象。这是整个 Channel 系统的**核心接口**。

```
// src/channels/plugins/types.plugin.ts
type ChannelPlugin<ResolvedAccount, Probe, Audit> = {
  id: ChannelId;            // 唯一标识，如 "telegram", "discord"
  meta: ChannelMeta;        // 名称、描述、文档路径等元信息
  capabilities: ChannelCapabilities; // 声明支持的消息类型

  // ────── 必填 ──────
  config: ChannelConfigAdapter;     // 账号配置的读写

  // ────── 可选 Adapter ──────
  gateway?:  ChannelGatewayAdapter;  // 生命周期：启动/停止账号监听
  outbound?: ChannelOutboundAdapter; // 出站：发文字/媒体/投票
  status?:   ChannelStatusAdapter;   // 状态探测与快照
  pairing?:  ChannelPairingAdapter;  // 用户配对（allowFrom 管理）
  security?: ChannelSecurityAdapter; // DM 策略、安全检查
  groups?:   ChannelGroupAdapter;    // 群组消息策略
  onboarding?: ChannelOnboardingAdapter; // CLI 引导向导
  streaming?:  ChannelStreamingAdapter;  // 流式回复
  threading?:  ChannelThreadingAdapter;  // 线程/话题支持
  messaging?:  ChannelMessagingAdapter;  // 消息编辑/删除等
  agentTools?: ChannelAgentTool[];       // Channel 专属 Agent 工具
  // ...还有 auth, commands, directory, heartbeat 等
};
```

**设计特点**：这是**结构性类型系统（structural typing）**而非类继承。Channel 不继承任何基类，只需满足 `ChannelPlugin` 的类型约束即可。不需要的能力直接省略对应字段。

### 1.2 关键 Adapter 接口

#### `ChannelGatewayAdapter` — 生命周期控制

```typescript
// src/channels/plugins/types.adapters.ts
type ChannelGatewayAdapter<ResolvedAccount> = {
  startAccount: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
  stopAccount?: (ctx: ...) => Promise<void>;
  logoutAccount?: (ctx: ...) => Promise<void>;
};

// startAccount 接收的上下文
type ChannelGatewayContext<ResolvedAccount> = {
  cfg: OpenClawConfig;       // 全局配置
  accountId: string;
  account: ResolvedAccount;  // 已解析的账号信息（token 等）
  abortSignal: AbortSignal;  // 用于优雅停止的信号
  setStatus: (next: ChannelAccountSnapshot) => void; // 更新运行时状态
  channelRuntime?: PluginRuntime; // 外部插件可用的 SDK 工具集
};
```

`startAccount` 是 Channel 的核心入口，调用后 Channel 开始监听第三方平台（轮询、Webhook、WebSocket 等）。

#### `ChannelOutboundAdapter` — 出站消息发送

```typescript
type ChannelOutboundAdapter = {
  deliveryMode: "direct" | "gateway" | "hybrid"; // 投递模式（必填）
  textChunkLimit?: number; // 文字消息的分块限制
  chunker?: (text: string, limit: number) => string[]; // 自定义分块函数

  sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  sendMedia?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  sendPoll?: (ctx: ChannelPollContext) => Promise<ChannelPollResult>;
  sendPayload?: (ctx: ChannelOutboundPayloadContext) => Promise<OutboundDeliveryResult>;
};
```

#### `ChannelConfigAdapter` — 账号配置

```typescript
type ChannelConfigAdapter<ResolvedAccount> = {
  listAccountIds:  (cfg: OpenClawConfig) => string[];    // 枚举所有账号
  resolveAccount:  (cfg: OpenClawConfig, accountId?) => ResolvedAccount; // 解析账号
  isEnabled?:      (account: ResolvedAccount, cfg) => boolean;
  isConfigured?:   (account: ResolvedAccount, cfg) => boolean | Promise<boolean>;
  resolveAllowFrom?: (...) => Array<string | number>; // 允许通信的用户列表
  // ...
};
```

---

## 二、消息完整流转路径

### 2.1 入站流程：第三方 → Agent

```
第三方平台（Telegram/Discord/...）
  │
  │  HTTP/WebSocket/轮询
  ▼
Channel 的 startAccount() 监听循环
  │  收到原始消息，构建标准化 MsgContext
  │
  ▼
resolveAgentRoute(channel, peer, cfg)     ← src/routing/resolve-route.ts
  │  根据 channel + accountId + sender 决定：
  │    - 路由到哪个 agentId
  │    - 生成唯一 sessionKey（对话上下文标识）
  │    - 检查 allowFrom 白名单
  │
  ▼
dispatchReplyWithBufferedBlockDispatcher() ← src/auto-reply/reply/provider-dispatcher.ts
  │  将 MsgContext 投递给 Agent 执行引擎
  │
  ▼
Agent 推理（LLM 调用、工具调用等）
  │  生成 ReplyPayload
  │
  ▼
deliverReplies()                          ← 各 channel 的 delivery 模块
  │
  ▼
ChannelOutboundAdapter.sendText() / sendMedia() / sendPayload()
  │
  ▼
第三方平台（回复消息）
```

### 2.2 以 Telegram 为例的具体实现

```
TelegramPollingSession（轮询） / Webhook 接收
  → GrammY Bot handler（src/telegram/bot.ts）
    → 构建 TelegramMessageContext（src/telegram/bot-message-context.ts）
      → resolveAgentRoute()  ← 路由决策
        → dispatchReply()    ← Agent 调度
          → telegramOutbound.sendText()  ← 通过 Telegram Bot API 发送
```

### 2.3 会话键（sessionKey）的作用

`resolveAgentRoute` 会为每个"对话"生成一个唯一的 `sessionKey`，格式大致为：

```
telegram:default:123456789   (channel:accountId:peerId)
```

这个 key 用于维持对话上下文（多轮对话的记忆），保证同一个用户在同一个 Channel 上的消息被串联到同一个 Agent session 中。

---

## 三、接口一致性的实现机制

OpenClaw **没有使用继承**来保证接口一致性，而是通过三个层面：

### 3.1 TypeScript 结构类型检查

所有 Channel 的 `ChannelPlugin` 对象都受同一个类型约束，TypeScript 编译期会检查：

- `config.listAccountIds` 和 `config.resolveAccount` 是否实现（必填）
- `capabilities` 中声明的能力与实际实现是否匹配
- Adapter 方法的参数/返回类型是否正确

### 3.2 `capabilities` 声明驱动行为

```typescript
type ChannelCapabilities = {
  chatTypes: ("direct" | "group" | "channel" | "thread")[];
  polls?: boolean;
  reactions?: boolean;
  threads?: boolean;
  media?: boolean;
  mentions?: boolean;
  streaming?: boolean;
  // ...
};
```

框架层根据 `capabilities` 判断是否调用对应 Adapter，不需要运行时 duck typing 检查。

### 3.3 `PluginRuntime` SDK —— 外部插件的标准工具集

外部 Channel 插件（第三方扩展）通过 `channelRuntime`（`PluginRuntime`）获得标准化工具，无需直接 import 内部模块：

```
channelRuntime.reply    → AI 回复调度、格式化、投递
channelRuntime.routing  → Agent 路由解析
channelRuntime.session  → Session 管理
channelRuntime.media    → 媒体获取与处理
channelRuntime.commands → 命令授权与处理
channelRuntime.pairing  → 用户配对管理
channelRuntime.text     → 文本分块、Markdown 处理
```

这是内置 Channel 和外部扩展 Channel 能力对齐的关键桥梁。

---

## 四、Channel 插件加载机制

### 4.1 发现阶段

`src/plugins/loader.ts` 中的 `discoverOpenClawPlugins()` 扫描以下路径寻找含 `openclaw.plugin.json` 的包：

1. **bundled**：`extensions/*/`（内置 Channel，随核心发布）
2. **config 目录**：`~/.openclaw/plugins/`
3. **workspace**：当前项目的 node_modules
4. **全局**：全局 npm 安装的插件

### 4.2 加载阶段

使用 [**jiti**](https://github.com/unjs/jiti) 动态执行插件入口文件（支持 TypeScript，无需预编译）：

```typescript
const mod = getJiti()(safeSource) as OpenClawPluginModule;
const resolved = resolvePluginModuleExport(mod);
resolved.register(api); // 调用插件的注册函数
```

### 4.3 注册阶段

插件通过 `api.registerChannel()` 将 `ChannelPlugin` 对象注入全局注册表：

```typescript
// extensions/telegram/index.ts
export default {
  id: "telegram",
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: telegramPlugin });
  },
};
```

注册后，`PluginRegistry.channels[]` 持有所有已注册 Channel，框架通过 `getChannelPlugin(id)` 按需获取。

### 4.4 Channel 注册表查询

```
src/channels/plugins/registry-loader.ts

createChannelRegistryLoader(resolveValue)
  → 返回一个 async (id) => TValue 的查询函数
  → 带内存缓存，首次查询后结果被缓存
  → 底层从 getActivePluginRegistry().channels 中按 id 匹配
```

---

## 五、Gateway 生命周期管理

`src/gateway/server-channels.ts` 中的 `createChannelManager()` 统一管理所有 Channel 账号的生命周期：

### 5.1 启动

```
startChannels()
  → 遍历所有已注册的 Channel
    → 对每个 accountId 调用 plugin.gateway.startAccount(ctx)
      → 各 Channel 开始监听循环
```

### 5.2 崩溃重启（指数退避）

```typescript
const CHANNEL_RESTART_POLICY = {
  initialMs: 5_000, // 首次等待 5 秒
  maxMs: 5 * 60_000, // 最长等待 5 分钟
  factor: 2, // 每次翻倍
  jitter: 0.1, // ±10% 随机抖动
};
const MAX_RESTART_ATTEMPTS = 10; // 最多重试 10 次
```

每个 Channel 账号独立管理，某个 Channel 崩溃不影响其他 Channel。

### 5.3 停止

通过 `AbortController` 优雅停止：

```typescript
// 触发停止
store.aborts.get(key)?.abort();

// Channel 内部监听
ctx.abortSignal.addEventListener("abort", () => {
  // 停止轮询/断开 WebSocket
});
```

---

## 六、内置 Channel vs 外部扩展 Channel 的对比

| 维度               | 内置 Channel（如 Telegram）          | 外部扩展（如 MS Teams）               |
| ------------------ | ------------------------------------ | ------------------------------------- |
| 业务逻辑位置       | `src/telegram/`                      | `extensions/msteams/src/`             |
| ChannelPlugin 定义 | `extensions/telegram/src/channel.ts` | `extensions/msteams/src/channel.ts`   |
| 结构               | **完全相同**                         | **完全相同**                          |
| 访问内部模块       | 可直接 import                        | 通过 `channelRuntime` SDK             |
| 发布方式           | 随 `openclaw` 核心发布               | 独立 npm 包（如 `@openclaw/msteams`） |
| 注册方式           | `api.registerChannel()`              | `api.registerChannel()`（相同）       |

---

## 七、总结

**你的猜想正确**，但可以细化：

1. **Channel 是适配器对象，不是类**：`ChannelPlugin` 是一个 plain object，包含若干 Adapter 字段，按需实现。

2. **与 Agent 的通信是间接的**：Channel 不直接调用 Agent，而是将消息投递给 **routing 层（resolveAgentRoute）** → **auto-reply dispatcher** → **Agent 执行引擎**。回复则反向经由 `ChannelOutboundAdapter` 发回。

3. **接口一致性靠类型系统**：没有基类，TypeScript 结构类型 + `capabilities` 声明 + `PluginRuntime` SDK 三层机制共同保证所有 Channel 行为的规范性。

4. **加载机制统一**：内置和外部扩展走完全相同的插件发现 → jiti 加载 → `api.registerChannel()` 注册流程，无任何特殊通道。

5. **生命周期由 Gateway 统一管理**：`ChannelManager` 负责所有 Channel 的启动、监控、指数退避重启和优雅停止。
