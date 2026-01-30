# 详细设计文档

本文档面向想深入理解 Moltbot 内部实现的读者，涵盖关键子系统的设计决策、接口定义和实现细节。

---

## 目录

1. [网关服务器设计](#1-网关服务器设计)
2. [渠道插件体系](#2-渠道插件体系)
3. [插件系统设计](#3-插件系统设计)
4. [Agent 引擎设计](#4-agent-引擎设计)
5. [配置系统设计](#5-配置系统设计)
6. [安全与权限设计](#6-安全与权限设计)
7. [媒体管线设计](#7-媒体管线设计)
8. [记忆系统设计](#8-记忆系统设计)
9. [出站投递设计](#9-出站投递设计)
10. [定时任务与钩子](#10-定时任务与钩子)

---

## 1. 网关服务器设计

### 1.1 架构角色

网关是 Moltbot 的"心脏"。它是一个长期运行的进程，承担以下职责：

```
网关服务器
├── HTTP 服务器        → 提供 Web UI、API 端点、健康检查
├── WebSocket 服务器   → 与 CLI 客户端、移动端实时通信
├── 渠道管理器         → 管理 15+ 个聊天平台的连接生命周期
├── 插件管理器         → 加载和管理扩展插件
├── 配置监听器         → 配置文件变更时自动重载
├── 定时任务调度器      → cron 任务执行
└── Agent 执行上下文    → 为 AI 调用提供运行环境
```

### 1.2 启动流程

```
moltbot gateway run --bind loopback --port 18789
    │
    ▼
1. 加载配置文件 (~/.moltbot/config.json)
    │
    ▼
2. 初始化日志系统（按子系统分类）
    │
    ▼
3. 加载插件注册表
   ├── 扫描 extensions/ 目录
   ├── 扫描 node_modules/
   ├── 校验各插件的 package.json
   └── 调用每个插件的 register() 函数
    │
    ▼
4. 创建渠道管理器
   ├── 合并内置渠道 Dock + 插件渠道
   └── 准备各渠道的启动/停止接口
    │
    ▼
5. 启动 HTTP + WebSocket 服务器
    │
    ▼
6. 启动各个已启用的渠道
   ├── Telegram: 开始轮询 / 设置 Webhook
   ├── Discord: 连接 Discord Gateway
   ├── Slack: 连接 Slack Socket Mode
   └── ...
    │
    ▼
7. 启动配置文件监听（热重载）
    │
    ▼
8. 启动定时任务调度器
    │
    ▼
✓ 网关就绪，开始处理消息
```

### 1.3 WebSocket 协议

网关通过 WebSocket 与客户端通信，支持以下消息类型：

```
客户端 → 网关:
  chat.send        # 发送聊天消息
  chat.abort        # 中止当前 Agent 运行
  channels.start    # 启动某个渠道
  channels.stop     # 停止某个渠道
  channels.status   # 查询渠道状态
  config.get        # 读取配置
  config.set        # 修改配置
  sessions.list     # 列出会话
  sessions.model    # 切换会话模型

网关 → 客户端:
  chat.partial      # 流式回复片段
  chat.complete     # 回复完成
  chat.tool         # 工具调用通知
  chat.error        # 错误通知
  channels.event    # 渠道状态变更
```

---

## 2. 渠道插件体系

### 2.1 核心接口定义

每个渠道需要实现 `ChannelPlugin` 接口。以下是完整的适配器列表：

```typescript
type ChannelPlugin = {
  // === 必填 ===
  id: ChannelId;                     // 渠道唯一标识，如 "telegram"
  meta: ChannelMeta;                 // 元信息：显示名、文档链接
  capabilities: ChannelCapabilities; // 能力声明
  config: ChannelConfigAdapter;      // 配置管理

  // === 可选（按需实现）===
  outbound?: ChannelOutboundAdapter;    // 消息发送
  gateway?: ChannelGatewayAdapter;      // 网关生命周期
  setup?: ChannelSetupAdapter;          // 初始配置向导
  pairing?: ChannelPairingAdapter;      // 设备配对
  security?: ChannelSecurityAdapter;    // 安全策略
  groups?: ChannelGroupAdapter;         // 群组管理
  mentions?: ChannelMentionAdapter;     // @提及处理
  status?: ChannelStatusAdapter;        // 健康状态
  threading?: ChannelThreadingAdapter;  // 线程模式
  agentPrompt?: ChannelAgentPromptAdapter; // 渠道特定提示词
  agentTools?: ChannelAgentToolFactory;    // 渠道特定工具
  auth?: ChannelAuthAdapter;            // 认证管理
  messaging?: ChannelMessagingAdapter;  // 消息处理
};
```

### 2.2 能力声明

```typescript
type ChannelCapabilities = {
  chatTypes: ("direct" | "group" | "channel" | "thread")[];
  nativeCommands?: boolean;     // 是否支持 /command 命令
  blockStreaming?: boolean;     // 是否禁用流式回复
  polls?: boolean;             // 是否支持投票
  reactions?: boolean;         // 是否支持表情反应
  inlineButtons?: boolean;     // 是否支持行内按钮
  voiceNotes?: boolean;        // 是否支持语音消息
  editMessages?: boolean;      // 是否支持编辑已发消息
};
```

### 2.3 出站适配器详解

这是最重要的适配器——负责把 AI 回复发送到平台：

```typescript
type ChannelOutboundAdapter = {
  // 发送纯文本
  sendText(ctx: {
    cfg: MoltbotConfig;
    to: string;              // 接收者/群组 ID
    text: string;
    replyToId?: string;      // 回复特定消息
    threadId?: string;       // 线程 ID
    accountId?: string;      // 使用的 bot 账号
  }): Promise<{ messageId: string }>;

  // 发送媒体（图片/文件/语音）
  sendMedia(ctx: {
    cfg: MoltbotConfig;
    to: string;
    mediaUrl: string;        // 媒体文件 URL 或本地路径
    caption?: string;        // 媒体说明文字
    mediaType?: "photo" | "document" | "voice" | "video";
  }): Promise<{ messageId: string }>;

  // 文本分块函数
  chunker?: (text: string, limit: number) => string[];

  // 单条消息最大字符数
  textChunkLimit: number;
};
```

### 2.4 网关生命周期适配器

```typescript
type ChannelGatewayAdapter = {
  // 启动账号监听（网关启动时调用）
  startAccount(opts: {
    cfg: MoltbotConfig;
    accountId: string;
    account: any;              // 渠道特定的账号配置
    runtime: PluginRuntime;    // 运行时依赖注入
    abortSignal: AbortSignal;  // 用于优雅关闭
    logger: Logger;
  }): Promise<void>;

  // 停止账号监听（网关关闭或渠道禁用时调用）
  stopAccount?(opts: {
    accountId: string;
  }): Promise<void>;
};
```

### 2.5 Dock 模式

`src/channels/dock.ts` 提供了一种轻量级的渠道注册方式，不需要加载完整的渠道依赖：

```
ChannelPlugin（完整实现）
    │
    │  buildDockFromPlugin()
    ▼
ChannelDock（轻量元数据）
    ├── id
    ├── capabilities
    ├── outbound.textChunkLimit
    ├── commands（命令适配器）
    ├── mentions（提及适配器）
    ├── threading（线程适配器）
    └── config.resolveAllowFrom()

为什么需要 Dock？
- 路由、权限检查、提及处理等共享代码只需要轻量元数据
- 避免加载完整渠道实现（如 Puppeteer、bot SDK）的开销
- 提高启动速度，减少内存占用
```

---

## 3. 插件系统设计

### 3.1 插件目录结构

```
extensions/my-plugin/
├── package.json          # 声明 moltbot.extensions 入口
├── src/
│   └── index.ts          # 插件主入口，导出 register 函数
├── tsconfig.json
└── README.md
```

`package.json` 中的关键字段：

```json
{
  "name": "@moltbot/my-plugin",
  "moltbot": {
    "extensions": "src/index.ts"
  },
  "dependencies": {
    // 插件特有的依赖放这里
  },
  "devDependencies": {
    "moltbot": "workspace:*"  // 开发时引用主包
  }
}
```

### 3.2 插件注册流程

```typescript
// 插件主入口 (src/index.ts)
import type { MoltbotPluginApi } from "moltbot/plugin-sdk";

export function register(api: MoltbotPluginApi) {
  // 注册一个新渠道
  api.registerChannel(myChannelPlugin);

  // 注册一个 Agent 工具
  api.registerTool({
    name: "my_tool",
    description: "做某件事",
    schema: { /* JSON Schema */ },
    handler: async (input) => {
      return { result: "done" };
    },
  });

  // 注册一个事件钩子
  api.on("inbound:message", async (event) => {
    // 消息入站前的处理
  });

  // 注册一个 HTTP 端点
  api.registerHttpRoute({
    path: "/my-plugin/webhook",
    method: "POST",
    handler: async (req, res) => {
      // 处理 webhook
    },
  });
}
```

### 3.3 MoltbotPluginApi

插件 API 提供以下能力：

```typescript
type MoltbotPluginApi = {
  // 插件自身信息
  id: string;
  name: string;
  version: string;
  source: string;

  // 配置
  config: MoltbotConfig;              // 全局配置
  pluginConfig: Record<string, any>;  // 插件自身的配置

  // 运行时（巨大的依赖注入对象）
  runtime: PluginRuntime;

  // 日志
  logger: {
    info: (...args) => void;
    warn: (...args) => void;
    error: (...args) => void;
  };

  // 注册方法
  registerChannel(plugin: ChannelPlugin): void;
  registerProvider(provider: ProviderPlugin): void;
  registerTool(tool: ToolRegistration): void;
  registerHook(name: string, handler: Function): void;
  registerGatewayMethod(name: string, handler: Function): void;
  registerHttpRoute(route: HttpRouteConfig): void;
  registerCli(registrar: CliRegistrar): void;
  registerCommand(command: CommandRegistration): void;

  // 类型安全的事件钩子
  on(event: "inbound:message", handler: Function): void;
  on(event: "outbound:message", handler: Function): void;
  on(event: "agent:start", handler: Function): void;
  on(event: "agent:end", handler: Function): void;
};
```

### 3.4 插件注册表

所有注册的能力汇聚到 `PluginRegistry`：

```typescript
type PluginRegistry = {
  plugins: PluginRecord[];              // 所有已加载的插件
  tools: PluginToolRegistration[];      // 所有注册的工具
  hooks: PluginHookRegistration[];      // 所有注册的钩子
  channels: PluginChannelRegistration[];// 所有注册的渠道
  providers: PluginProviderRegistration[]; // 所有注册的提供商
  httpHandlers: PluginHttpRegistration[];  // 所有 HTTP 处理器
  gatewayHandlers: GatewayRequestHandlers;// 网关 RPC 方法
  services: PluginServiceRegistration[];   // 后台服务
  commands: PluginCommandRegistration[];   // 命令注册
  diagnostics: PluginDiagnostic[];        // 诊断信息
};
```

---

## 4. Agent 引擎设计

### 4.1 执行入口（run.ts）

```
runEmbeddedPiAgent(options)
    │
    ├── 参数:
    │   ├── prompt: string            用户消息文本
    │   ├── agentId: string           Agent 标识
    │   ├── sessionKey: string        会话标识
    │   ├── channel: string           来源渠道
    │   ├── model?: string            指定模型（可选）
    │   ├── thinkingLevel?: string    推理级别
    │   ├── onPartialReply: Function  流式回复回调
    │   ├── onToolResult: Function    工具结果回调
    │   └── abortSignal: AbortSignal  取消信号
    │
    └── 返回: EmbeddedPiRunResult
```

### 4.2 单次尝试流程（attempt.ts）

```
attemptEmbeddedPiRun()
    │
    ▼
1. 打开 SessionManager
   └── 加载 JSONL 对话文件
    │
    ▼
2. 清理历史
   ├── 移除敏感数据（API Key 等）
   ├── 校验角色交替（user ↔ assistant）
   └── 截断到历史限制
    │
    ▼
3. 构建系统提示词
   └── buildEmbeddedSystemPrompt()
    │
    ▼
4. 检测并加载图片
   ├── 扫描 prompt 中的文件路径
   ├── 加载图片文件
   └── 检查模型是否支持视觉
    │
    ▼
5. 创建工具集
   ├── 基础工具（read, write, exec, ...）
   ├── Moltbot 工具（message, web_search, ...）
   ├── 插件工具
   └── 策略过滤
    │
    ▼
6. 创建 Agent Session
   ├── 设置模型参数（temperature, max_tokens 等）
   ├── 注入历史消息
   └── 绑定工具定义
    │
    ▼
7. 执行 before_agent_start 钩子
    │
    ▼
8. 提交 prompt
   └── session.prompt(text, { images })
    │
    ▼
9. 订阅流式响应
   └── subscribeEmbeddedPiSession()
    │
    ▼
10. 等待完成或错误
    ├── 成功: 组装 payloads
    ├── 上下文溢出: 压缩历史，重试
    ├── 认证失败: 切换 Auth Profile
    └── 其他错误: 抛出给上层处理
    │
    ▼
11. 执行 agent_end 钩子
    │
    ▼
12. 返回结果
```

### 4.3 流式订阅状态机（subscribe.ts）

```typescript
// 订阅器维护的状态
type SubscriptionState = {
  assistantTexts: string[];         // AI 回复的文本块列表
  toolMetas: ToolMeta[];            // 工具调用记录
  blockState: {
    inThinkBlock: boolean;          // 当前是否在 <think> 块中
    inFinalBlock: boolean;          // 当前是否在 <final> 块中
    inCodeBlock: boolean;           // 当前是否在代码块中
  };
  blockBuffer: string;              // 文本累积缓冲区
  deltaBuffer: string;              // 原始 delta 缓冲区
  messagingToolSentTexts: string[]; // 通过 message 工具发送的文本（用于去重）
  compactionInFlight: boolean;      // 是否正在进行上下文压缩
};
```

事件处理：

```
text_delta 事件:
  → 追加到 deltaBuffer
  → 解析块标签（<think>, <final>, 代码块等）
  → 追加到对应的 blockBuffer
  → 触发 onPartialReply（实时推送给前端/渠道）

tool_use 事件:
  → 记录工具名称和参数到 toolMetas
  → 执行工具（由 PI SDK 内部处理）
  → 工具结果作为 tool_result 消息加入对话
  → 触发 onToolResult 回调

message_stop 事件:
  → 刷新所有缓冲区
  → 将最后一块文本加入 assistantTexts
  → 标记流结束

error 事件:
  → 分类错误类型
  → 触发错误处理逻辑
```

### 4.4 上下文压缩算法（compaction.ts）

```
输入: 一组超出上下文窗口的消息

算法:
  1. 计算目标压缩大小
     target = contextWindow * BASE_CHUNK_RATIO (40%)

  2. 将消息分成 N 个块
     每个块 ≈ target tokens

  3. 对每个块独立摘要
     prompt: "请将以下对话摘要为简洁的要点..."
     model: 当前使用的同一模型

  4. 合并所有摘要
     prompt: "请将以下摘要合并为一个连贯的总结..."

  5. 如果合并后仍然太大
     → 使用部分摘要（排除过大的消息）
     → 最终降级: 仅保留"对话过长，已截断"的注释

安全边界:
  SAFETY_MARGIN = 1.2 (留 20% 余量，因为 token 计数是估算的)
  MIN_CHUNK_RATIO = 0.15 (每块至少占上下文的 15%)
```

---

## 5. 配置系统设计

### 5.1 配置文件格式

使用 JSON5（JSON 的超集，支持注释和尾逗号）：

```json5
// ~/.moltbot/config.json
{
  // AI 模型配置
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-20250514",
        fallbacks: ["google/gemini-2.0-flash"],
      },
      // 多个 API Key 轮转
      authProfiles: {
        anthropic: ["personal", "team"],
      },
    },
  },

  // 渠道配置
  channels: {
    telegram: {
      accounts: [{
        token: "123456:ABC-DEF...",
        allowFrom: [{ id: "user123" }],
      }],
    },
    discord: {
      accounts: [{
        token: "discord-bot-token",
        guilds: ["guild-id"],
      }],
    },
  },

  // 网关配置
  gateway: {
    bind: "loopback",
    port: 18789,
  },
}
```

### 5.2 校验机制

使用 Zod Schema 进行运行时校验：

```
加载配置流程:

1. 读取 JSON5 文件
    │
    ▼
2. Zod Schema 校验
   ├── 类型检查（字段类型正确？）
   ├── 必填检查（必要字段存在？）
   ├── 格式检查（Token 格式正确？）
   └── 范围检查（端口号在合法范围？）
    │
    ▼
3. 遗留格式迁移 (legacy-migrate.ts)
   └── 旧版配置自动升级到新版格式
    │
    ▼
4. 运行时覆盖 (runtime-overrides.ts)
   └── 环境变量覆盖配置值
    │
    ▼
5. 返回类型安全的 MoltbotConfig 对象
```

### 5.3 配置热重载

```
网关运行时:

配置文件监听器 (fs.watch)
    │
    ▼ (文件变更)
    │
重新加载配置
    │
    ▼
对比变更的配置段
    │
    ├── channels 变更 → 重启受影响的渠道
    ├── agents 变更   → 更新 Agent 配置
    ├── gateway 变更  → 某些需要重启网关
    └── plugins 变更  → 重新加载插件
```

---

## 6. 安全与权限设计

### 6.1 允许列表（Allowlist）

每个渠道账号都可以配置 `allowFrom`，控制谁可以使用 Bot：

```json5
{
  channels: {
    telegram: {
      accounts: [{
        token: "...",
        allowFrom: [
          { id: "user123" },          // 特定用户
          { id: "group456" },         // 特定群组
          { id: "*" },                // 所有人（开放）
        ],
      }],
    },
  },
}
```

### 6.2 命令执行审批

**文件**: `src/infra/exec-approvals.ts`

当 AI Agent 想执行 shell 命令时，可能需要用户审批：

```
Agent 想执行: rm -rf /tmp/data

审批流程:
1. 检查命令是否在安全白名单中
   ├── 安全命令（ls, cat, echo 等）→ 自动批准
   └── 危险命令（rm, sudo 等）→ 需要审批

2. 如果需要审批:
   ├── 发送审批请求给用户
   ├── 等待用户确认（approve/deny）
   └── 超时自动拒绝

3. 沙箱模式:
   ├── 限制文件系统访问范围
   ├── 禁止网络访问（可选）
   └── 禁止特定命令
```

### 6.3 设备配对

新设备首次连接需要配对：

```
新设备 ──→ 发送配对请求 ──→ 网关
                              │
                              ▼
                         已配对设备收到通知
                         "新设备想连接，是否允许？"
                              │
                         用户确认
                              │
                              ▼
                         设备配对成功
                         生成持久化令牌
```

---

## 7. 媒体管线设计

### 7.1 入站媒体处理

```
用户发送图片/文件/语音
    │
    ▼
渠道适配器提取媒体信息
├── 文件 ID（平台特定）
├── MIME 类型
├── 文件大小
└── 缩略图/预览
    │
    ▼
下载媒体文件 (media/fetch.ts)
├── 从平台 CDN 下载
├── 尊重大小限制 (MAX_IMAGE_BYTES)
└── 超时控制
    │
    ▼
缓存到本地 (media/store.ts)
└── ~/.moltbot/media/<hash>.<ext>
    │
    ▼
图片处理 (media/image-ops.ts)（如果需要）
├── 缩放到合适尺寸
├── 格式转换（如 WebP → PNG）
└── 压缩
    │
    ▼
提供给 Agent（作为图片 content 或文件路径）
```

### 7.2 出站媒体处理

```
Agent 生成媒体（如图片生成工具）
    │
    ▼
保存到本地文件
    │
    ▼
通过渠道出站适配器发送
├── Telegram: 直接发送文件
├── Discord: 上传附件
├── Slack: 上传到 Slack 文件 API
└── WhatsApp: 先上传到媒体服务器
```

---

## 8. 记忆系统设计

### 8.1 记忆存储

```
用户对话 ──→ 提取重要信息 ──→ 生成嵌入向量 ──→ 存储到向量数据库

向量数据库选项:
├── 内置: 简单的基于文件的向量存储
├── LanceDB: 通过 extensions/memory-lancedb 扩展
└── 其他: 通过 extensions/memory-core 扩展
```

### 8.2 记忆检索

```
Agent 需要回忆 ──→ memory_search 工具
    │
    ▼
语义搜索:
1. 将查询文本生成嵌入向量
2. 在向量数据库中搜索最近邻
3. 返回最相关的记忆片段

混合搜索 (hybrid.ts):
├── 向量相似度搜索（语义匹配）
├── 关键词搜索（精确匹配）
└── 合并 + 去重 + 重排序
```

---

## 9. 出站投递设计

### 9.1 投递流程

```
Agent 回复 (payloads[])
    │
    ▼
确定投递目标 (outbound/targets.ts)
├── 原渠道回复（最常见）
├── 跨渠道转发
└── 多目标广播
    │
    ▼
文本分块 (auto-reply/chunk.ts)
├── 按平台限制分割
├── 保持代码块完整
├── 保持段落完整
└── 保持列表完整
    │
    ▼
格式化 (auto-reply/envelope.ts)
├── Markdown → 平台特定格式
├── Telegram: HTML 格式
├── Discord: Discord Markdown
├── Slack: mrkdwn 格式
└── Signal: 纯文本
    │
    ▼
发送 (via ChannelOutboundAdapter)
├── sendText() → 发送文本块
├── sendMedia() → 发送媒体附件
└── 返回 messageId 用于后续引用
```

### 9.2 智能分块算法

```typescript
// 分块策略（伪代码）
function chunkText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    // 1. 尝试在段落边界分割
    let splitAt = findParagraphBoundary(remaining, limit);

    // 2. 如果没有段落边界，尝试在句子边界分割
    if (splitAt === -1) {
      splitAt = findSentenceBoundary(remaining, limit);
    }

    // 3. 如果在代码块内部，找到代码块结束位置
    if (isInsideCodeBlock(remaining, splitAt)) {
      splitAt = findCodeBlockEnd(remaining, splitAt);
    }

    // 4. 最后的手段：在字符限制处硬分割
    if (splitAt === -1) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
```

---

## 10. 定时任务与钩子

### 10.1 定时任务（Cron）

**文件**: `src/cron/`

```
配置:
  cron: [
    {
      schedule: "0 9 * * *",        // 每天早上 9 点
      agent: "default",
      prompt: "给我今天的新闻摘要",
      channel: "telegram",
      to: "user123"
    }
  ]

执行流程:
  调度器检测到触发时间
      │
      ▼
  创建 Agent 运行
      │
      ▼
  执行 prompt
      │
      ▼
  将结果发送到指定渠道/用户
```

### 10.2 钩子（Hooks）

**文件**: `src/hooks/`

用户可以在配置中定义自动化规则：

```json5
{
  hooks: {
    // 在 Agent 启动前执行
    before_agent_start: [
      { exec: "echo 'Agent starting'" }
    ],
    // 在 Agent 结束后执行
    agent_end: [
      { exec: "echo 'Agent finished'" }
    ],
    // 消息入站时执行
    inbound_message: [
      { exec: "logger.sh $MESSAGE" }
    ],
  },
}
```

---

## 附录：关键设计决策

### 为什么选择文件系统而不是数据库？

```
决策: 对话历史用 JSONL 文件存储，不用数据库

原因:
1. 零依赖：不需要安装 PostgreSQL/MongoDB
2. 可移植：复制文件即可迁移
3. 可调试：直接用文本编辑器查看
4. 够用了：单用户场景下文件 I/O 足够快
```

### 为什么用 Dock 模式而不是直接用 Plugin？

```
决策: 渠道有两层注册——轻量的 Dock 和完整的 Plugin

原因:
1. 很多共享代码（路由、权限）只需要元数据，不需要完整渠道
2. 加载完整渠道很重（如 Puppeteer for WhatsApp Web）
3. Dock 只包含必要的元数据，启动极快
4. 按需加载完整 Plugin，减少内存占用
```

### 为什么支持多 Auth Profile？

```
决策: 同一个提供商可以配置多个 API Key

原因:
1. API Key 有速率限制，多 Key 轮转可以提高吞吐
2. 某些 Key 可能过期/被封，自动切换避免中断
3. 个人/团队 Key 可以设置优先级
4. 冷却机制防止反复重试同一个失败的 Key
```

### 为什么自动压缩而不是截断？

```
决策: 对话过长时自动摘要压缩，而不是简单截断

原因:
1. 截断会丢失上下文，AI 会忘记之前讨论的内容
2. 摘要保留了关键信息，AI 仍然能理解上下文
3. 用户体验更好——对话不会突然"失忆"
4. 代价是多消耗一些 token 用于摘要，但值得
```
