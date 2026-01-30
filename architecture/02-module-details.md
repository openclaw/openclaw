# 各模块详细说明

本文档逐个介绍 Moltbot 项目中每个核心模块的职责、关键文件和对外接口。

---

## 1. Agent 引擎 (`src/agents/`)

**一句话**：这是 Moltbot 的"大脑"，负责调用大模型、管理工具、处理流式响应。

### 子目录结构

```
src/agents/
├── pi-embedded-runner/       # 核心执行引擎
│   ├── run.ts                # 主入口：编排 auth、session、prompt、错误处理
│   ├── run/
│   │   ├── attempt.ts        # 单次 API 调用：加载会话 → 提交 prompt → 流式接收
│   │   └── payloads.ts       # 响应组装：错误文本 + 推理 + 回答 + 工具结果
│   ├── subscribe.ts          # 流式事件订阅：text_delta、tool_call、message_stop
│   ├── compact.ts            # Token 优化 / 上下文压缩
│   └── history.ts            # 会话历史管理
├── tools/                    # 工具定义（Agent 可调用的能力）
│   ├── message-tool.ts       # 发消息到各渠道
│   ├── browser-tool.ts       # 浏览器自动化
│   ├── web-fetch.ts          # 网页抓取
│   ├── image-tool.ts         # 图片生成/编辑
│   └── sessions-send-tool.ts # 跨 Agent 消息传递
├── model-selection.ts        # 模型选择：解析配置、别名、默认值
├── model-fallback.ts         # 模型降级：主模型失败时切换到备选
├── model-auth.ts             # 认证管理：API Key 轮转、健康检查
├── system-prompt.ts          # 系统提示词构建：动态组装 20+ 段内容
├── context-window-guard.ts   # 上下文窗口校验：最小 16K token
├── compaction.ts             # 会话压缩：超长对话自动摘要
├── pi-tools.ts               # 工具注册中心 + 策略过滤
├── identity.ts               # Agent 身份/人格设置
└── auth-profiles.ts          # 认证档案：多 Key 轮转 + 冷却期
```

### 关键概念

| 概念 | 说明 |
|------|------|
| Auth Profile | 一个 API Key + 提供商的配置。系统维护多个 Profile，失败时自动切换 |
| Session | 一段持久化对话。存储在 JSONL 文件中，包含完整对话历史 |
| Tool | Agent 可以调用的能力（发消息、搜索、浏览网页等）。每个工具有 JSON Schema 定义 |
| Compaction | 当对话历史超过上下文窗口时，自动摘要压缩旧消息 |
| Fallback | 主模型不可用时，按配置的备选列表依次尝试 |

---

## 2. 网关服务器 (`src/gateway/`)

**一句话**：中央控制器，管理所有渠道的生命周期，处理 WebSocket/HTTP 请求。

### 关键文件

```
src/gateway/
├── server.impl.ts            # 网关主实现：初始化插件、渠道、HTTP 服务
├── server.ts                 # 公共接口定义
├── server-channels.ts        # 渠道管理器：启动/停止各渠道账号
├── server-chat.ts            # 聊天消息处理
├── server-sessions.ts        # 会话管理
├── protocol/                 # WebSocket 协议定义
├── server-methods/           # RPC 方法处理器
└── client.ts                 # WebSocket 客户端管理
```

### 网关做什么

1. **启动时**：加载配置 → 初始化插件注册表 → 启动各渠道 → 打开 WebSocket 服务
2. **运行时**：接收入站消息 → 路由到 Agent → 投递回复 → 处理 RPC 请求
3. **管理**：渠道的启动/停止/重启，配置热重载，健康检查

---

## 3. 渠道系统 (`src/channels/`)

**一句话**：把不同聊天平台抽象成统一接口，让上层代码不用关心具体平台差异。

### 核心抽象

```typescript
// 每个渠道插件需要实现的接口（简化版）
type ChannelPlugin = {
  id: string;                    // "telegram" | "discord" | ...
  meta: { label: string };       // 显示名称
  capabilities: {                // 能力声明
    chatTypes: ("direct" | "group" | "thread")[];
    nativeCommands: boolean;
    blockStreaming: boolean;
  };
  config: {                      // 配置适配器
    listAccounts(): Account[];   // 列出已配置的账号
    isEnabled(): boolean;        // 是否启用
  };
  outbound: {                    // 出站适配器
    sendText(ctx): Promise<Result>;  // 发送文本
    sendMedia(ctx): Promise<Result>; // 发送媒体
    textChunkLimit: number;          // 单条消息最大字符数
  };
  gateway: {                     // 网关生命周期
    startAccount(opts): Promise<void>;  // 启动账号监听
    stopAccount(opts): Promise<void>;   // 停止账号监听
  };
};
```

### 内置渠道 vs 扩展渠道

| 类型 | 位置 | 示例 |
|------|------|------|
| 内置 | `src/telegram/`, `src/discord/`, ... | Telegram, Discord, Slack, Signal, iMessage, WhatsApp |
| 扩展 | `extensions/matrix/`, `extensions/msteams/`, ... | Matrix, Teams, Google Chat, Twitch, Nostr |

两者实现相同的 `ChannelPlugin` 接口，区别只是内置渠道随主包发布，扩展需要额外安装。

### Dock（码头）模式

`src/channels/dock.ts` 提供轻量级渠道注册表：
- 不引入重依赖（不加载 Puppeteer、bot SDK 等）
- 只存放元数据和简单适配器
- 用于共享代码路径（路由、权限检查、提及处理）

---

## 4. 路由系统 (`src/routing/`)

**一句话**：决定一条入站消息应该由哪个 Agent、哪个 Session 来处理。

### 路由解析流程

```
入站消息（来自渠道）
    │
    ▼
resolveAgentRoute()
    │
    ├── 1. 检查发送者(peer)级别的绑定
    ├── 2. 检查群组(guild/team)级别的绑定
    ├── 3. 检查账号(account)级别的绑定
    ├── 4. 检查渠道(channel)级别的绑定
    └── 5. 使用默认 Agent
    │
    ▼
返回: { agentId, sessionKey, accountId }
```

### Session Key 格式

```
agent-id : main|peer : channel : peer-kind : peer-id
例如: default : main : telegram : user : 123456789
```

Session Key 唯一标识一段对话，决定了对话历史的隔离范围。

---

## 5. 自动回复管线 (`src/auto-reply/`)

**一句话**：入站消息 → AI 调用 → 回复生成的完整管线。

```
src/auto-reply/
├── inbound.ts            # 入站处理：接收消息、权限检查、命令识别
├── reply/
│   ├── reply.ts          # 主回复逻辑：调用 Agent → 收集结果
│   ├── provider-dispatcher.ts  # 选择使用哪个 AI 提供商
│   └── history.ts        # 构建对话历史上下文
├── chunk.ts              # 回复分块：长回复按平台限制拆分
├── envelope.ts           # 消息封装/格式化
└── commands-registry.ts  # 内置命令处理（/help, /model 等）
```

---

## 6. 配置系统 (`src/config/`)

**一句话**：统一管理所有配置，支持 JSON5 格式、Zod 校验、热重载。

### 配置文件位置

默认在 `~/.moltbot/config.json`（JSON5 格式）

### 配置结构（简化版）

```typescript
type MoltbotConfig = {
  channels?: {
    telegram?: TelegramConfig;
    discord?: DiscordConfig;
    // ...每个渠道的配置
  };
  agents?: {
    defaults?: {
      model: { primary: string; fallbacks: string[] };
      authProfiles: Record<string, string[]>;
    };
    list?: AgentConfig[];
  };
  gateway?: {
    bind?: "loopback" | "lan" | "tailnet";
    auth?: GatewayAuthConfig;
  };
  plugins?: {
    enabled?: string[];
    disabled?: string[];
  };
  // ...更多
};
```

---

## 7. 插件系统 (`src/plugins/`)

**一句话**：让第三方开发者可以扩展 Moltbot 的渠道、工具、钩子等能力。

### 插件生命周期

```
1. 发现 (Discovery)
   └── 扫描 extensions/、node_modules/ 等路径

2. 加载 (Loading)
   └── 用 jiti 动态加载 TypeScript 模块

3. 校验 (Validation)
   └── 检查 ID、配置 Schema、启用状态

4. 注册 (Registration)
   └── 调用插件的 register() 函数
   └── 插件通过 MoltbotPluginApi 注册各种能力

5. 运行 (Runtime)
   └── 渠道插件开始监听消息
   └── 工具插件可被 Agent 调用
```

### 插件可以注册什么

| 注册类型 | 说明 |
|---------|------|
| Channel | 新的聊天平台渠道 |
| Provider | 新的 AI 模型提供商 |
| Tool | 新的 Agent 工具 |
| Hook | 事件钩子（消息入站前/后） |
| HTTP Route | 新的 HTTP 端点 |
| Gateway Method | 新的 RPC 方法 |
| CLI Command | 新的命令行子命令 |

---

## 8. 媒体管线 (`src/media/`)

**一句话**：处理图片、音频、视频等多媒体文件的下载、缓存和格式转换。

```
src/media/
├── fetch.ts       # 从 URL 下载媒体文件
├── store.ts       # 缓存到 ~/.moltbot/media/
├── image-ops.ts   # 图片处理：缩放、压缩、格式转换
├── mime.ts        # MIME 类型检测
└── parse.ts       # 从消息中提取媒体附件
```

---

## 9. 向量记忆 (`src/memory/`)

**一句话**：让 Agent 拥有长期记忆，通过向量嵌入实现语义搜索。

```
src/memory/
├── manager.ts      # 记忆管理器：嵌入、索引、搜索（75KB，最大文件）
├── embeddings.ts   # 调用嵌入 API 生成向量
├── batch-*.ts      # 批量处理
└── hybrid.ts       # 混合搜索（向量 + 关键词）
```

---

## 10. CLI (`src/cli/` + `src/commands/`)

**一句话**：命令行工具，用于启动网关、管理渠道、发送消息、配置系统。

### 主要命令

```bash
moltbot gateway run     # 启动网关服务器
moltbot agent           # 启动交互式 Agent 会话
moltbot channels status # 查看渠道状态
moltbot config set ...  # 修改配置
moltbot message send    # 发送消息
moltbot login           # 登录 Web 提供商
moltbot doctor          # 诊断问题
```

### 依赖注入

`src/cli/deps.ts` 提供 `createDefaultDeps()` 函数，将各渠道的发送函数注入到命令处理器中：

```typescript
type CliDeps = {
  sendMessageWhatsApp: Function;
  sendMessageTelegram: Function;
  sendMessageDiscord: Function;
  sendMessageSlack: Function;
  sendMessageSignal: Function;
  sendMessageIMessage: Function;
};
```

---

## 11. 基础设施 (`src/infra/`)

**一句话**：跨模块共享的基础能力。

| 文件 | 功能 |
|------|------|
| `exec-approvals.ts` | 命令执行审批系统（危险操作需用户确认） |
| `provider-usage.*.ts` | API 用量统计和计费追踪 |
| `device-pairing.ts` | 设备配对/认证 |
| `agent-events.ts` | Agent 生命周期事件 |
| `binaries.ts` | 外部二进制依赖管理 |
| `fetch.ts` | HTTP 客户端封装 |

---

## 12. 浏览器自动化 (`src/browser/`)

**一句话**：让 Agent 可以控制真实浏览器，执行网页操作。

```
src/browser/
├── client.ts           # 浏览器客户端封装
├── cdp.ts              # Chrome DevTools Protocol 通信
├── pw-session.ts       # Playwright 会话管理
├── extension-relay.ts  # 浏览器扩展中继
└── chrome.ts           # Chrome 二进制查找/启动
```

---

## 13. 扩展目录 (`extensions/`)

每个扩展是一个独立的 workspace 包，拥有自己的 `package.json`。

### 渠道扩展

| 扩展 | 平台 |
|------|------|
| `extensions/matrix/` | Matrix 协议 |
| `extensions/msteams/` | Microsoft Teams |
| `extensions/googlechat/` | Google Chat |
| `extensions/mattermost/` | Mattermost |
| `extensions/twitch/` | Twitch 直播 |
| `extensions/nostr/` | Nostr 去中心化协议 |
| `extensions/zalo/` | Zalo（越南） |
| `extensions/line/` | LINE |

### 功能扩展

| 扩展 | 功能 |
|------|------|
| `extensions/memory-core/` | 向量数据库记忆后端 |
| `extensions/memory-lancedb/` | LanceDB 记忆存储 |
| `extensions/voice-call/` | 语音通话 |
| `extensions/lobster/` | 私有 LLM 集成 |
| `extensions/diagnostics-otel/` | OpenTelemetry 诊断 |

---

## 下一步阅读

- [03-agent-llm-interaction.md](./03-agent-llm-interaction.md) — Agent 与大模型的交互流程
- [04-detailed-design.md](./04-detailed-design.md) — 详细设计文档
