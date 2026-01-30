# Agent 调度与大模型交互流程

本文档详细说明 Moltbot 的 Agent 是如何调度的、如何与大模型进行交互、交互的完整流程和内容。

---

## 总体流程图

```
┌─────────────────────────────────────────────────────────────────┐
│                        完整消息处理流程                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  用户消息 ──→ 渠道接收 ──→ 路由解析 ──→ Agent 调度              │
│                                           │                     │
│                                           ▼                     │
│                                    ┌─────────────┐             │
│                                    │  模型选择     │             │
│                                    │  (哪个AI)    │             │
│                                    └──────┬──────┘             │
│                                           │                     │
│                                           ▼                     │
│                                    ┌─────────────┐             │
│                                    │  认证解析     │             │
│                                    │  (哪个API Key)│             │
│                                    └──────┬──────┘             │
│                                           │                     │
│                                           ▼                     │
│                                    ┌─────────────┐             │
│                                    │ 系统提示词构建 │             │
│                                    │ (告诉AI它是谁) │             │
│                                    └──────┬──────┘             │
│                                           │                     │
│                                           ▼                     │
│                                    ┌─────────────┐             │
│                                    │  工具注册     │             │
│                                    │  (AI能用什么) │             │
│                                    └──────┬──────┘             │
│                                           │                     │
│                                           ▼                     │
│                               ┌───────────────────┐            │
│                               │   调用 LLM API     │            │
│                               │  (发送请求给大模型)  │            │
│                               └─────────┬─────────┘            │
│                                         │                       │
│                                    流式响应                      │
│                                         │                       │
│                                         ▼                       │
│                               ┌───────────────────┐            │
│                               │  处理响应           │            │
│                               │  文本 / 工具调用    │            │
│                               └─────────┬─────────┘            │
│                                         │                       │
│                          ┌──────────────┼──────────────┐       │
│                          ▼              ▼              ▼       │
│                     纯文本回复     执行工具调用     推理内容     │
│                          │              │              │       │
│                          │         执行完毕后           │       │
│                          │         再次调用 LLM         │       │
│                          │         (把结果告诉AI)        │       │
│                          │              │              │       │
│                          ▼              ▼              ▼       │
│                     ┌──────────────────────────────────┐       │
│                     │     组装最终回复 → 投递到渠道       │       │
│                     └──────────────────────────────────┘       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 第一阶段：消息入站与路由

### 1.1 渠道接收消息

当用户在 Telegram 发送一条消息时：

```
Telegram 服务器 ──webhook/轮询──→ src/telegram/bot-handlers.ts
```

每个渠道都有自己的监听器（monitor），负责：
- 接收平台的原始事件
- 解析出消息文本、发送者信息、群组信息、媒体附件
- 转换成统一的内部消息格式

### 1.2 路由解析

**文件**: `src/routing/resolve-route.ts`

系统需要决定：这条消息应该由**哪个 Agent** 来处理？

```typescript
// 路由解析的输入
输入 = {
  channel: "telegram",        // 来自哪个平台
  peerId: "123456789",        // 发送者 ID
  peerKind: "user",           // 用户 or 群组
  guildId: undefined,         // 群组 ID（如果有）
  accountId: "bot_token_xxx"  // 使用的 bot 账号
}

// 解析逻辑（按优先级）
1. 先查有没有针对这个具体用户的绑定  → 例如用户A绑定到Agent-写作
2. 再查有没有针对这个群组的绑定        → 例如群X绑定到Agent-客服
3. 再查有没有针对这个账号的绑定        → 例如bot账号绑定到Agent-助手
4. 再查有没有渠道级别的默认绑定
5. 最后用系统默认 Agent

// 路由解析的输出
输出 = {
  agentId: "default",
  sessionKey: "default:main:telegram:user:123456789",
  accountId: "bot_token_xxx"
}
```

**Session Key** 是对话隔离的关键。不同的 Session Key 意味着独立的对话历史。

---

## 第二阶段：Agent 调度

### 2.1 Agent 执行入口

**文件**: `src/agents/pi-embedded-runner/run.ts`

这是整个 Agent 系统的核心编排器。它的职责是：

```
runEmbeddedPiAgent() {
  1. 解析要使用的模型
  2. 确定认证方式（API Key）
  3. 尝试调用模型
  4. 如果失败，切换到备选模型
  5. 返回最终结果
}
```

### 2.2 模型选择

**文件**: `src/agents/model-selection.ts`

```
如何决定用哪个模型？

配置优先级（从高到低）：
1. 用户临时指定（如 /model claude-opus-4-5）
2. 会话级覆盖（特定对话使用特定模型）
3. Agent 级配置（agents.list[i].model）
4. 全局默认（agents.defaults.model.primary）
5. 硬编码默认（anthropic/claude-opus-4-5）

模型别名支持：
  "opus"  → "anthropic/claude-opus-4-5"
  "sonnet" → "anthropic/claude-sonnet-4-20250514"
  "gpt4"  → "openai/gpt-4o"
  "gemini" → "google/gemini-2.0-flash"
```

### 2.3 模型降级（Fallback）

**文件**: `src/agents/model-fallback.ts`

```
如果主模型调用失败怎么办？

runWithModelFallback() 的逻辑：

  候选列表 = [主模型, 降级模型1, 降级模型2, ...]

  for 每个候选模型:
    try:
      result = 调用该模型
      return result  // 成功就返回
    catch error:
      if error 是认证/限流/超时:
        标记该模型冷却
        继续尝试下一个
      else:
        抛出错误（不可恢复）

降级配置示例：
  primary: "anthropic/claude-opus-4-5"
  fallbacks: [
    "anthropic/claude-sonnet-4-20250514",
    "google/gemini-2.0-flash"
  ]
```

---

## 第三阶段：与大模型交互

### 3.1 认证解析

**文件**: `src/agents/auth-profiles.ts`, `model-auth.ts`

系统支持同一个提供商配置多个 API Key（称为 Auth Profile）：

```
每个提供商可以有多个 Auth Profile：

anthropic:
  profile-1: sk-ant-xxx1  (个人 Key)
  profile-2: sk-ant-xxx2  (团队 Key)
  profile-3: sk-ant-xxx3  (备用 Key)

选择顺序：
1. 用户锁定的 Profile（通过 --auth-profile 指定）
2. 首选 Profile（配置中指定）
3. 按顺序尝试列表中的 Profile
4. 跳过处于冷却期的 Profile

冷却机制：
  认证失败 → 标记冷却 60 秒
  限流失败 → 标记冷却 30 秒
  超时失败 → 标记冷却 15 秒
```

### 3.2 构建系统提示词（System Prompt）

**文件**: `src/agents/system-prompt.ts`

系统提示词是告诉 AI "你是谁、能做什么"的关键内容。Moltbot 动态组装 20+ 个段落：

```
系统提示词的结构：

┌─────────────────────────────────────────┐
│ 1. 身份定义                              │
│    "你是一个运行在 Moltbot 中的个人助手"    │
├─────────────────────────────────────────┤
│ 2. 可用工具列表                           │
│    - exec: 执行 shell 命令                │
│    - message: 发消息到聊天平台              │
│    - web_search: 搜索互联网                │
│    - web_fetch: 获取网页内容               │
│    - browser: 控制浏览器                   │
│    - read/write/edit: 文件操作             │
│    ...                                   │
├─────────────────────────────────────────┤
│ 3. 工具使用风格指导                        │
│    如何描述工具调用，何时需要确认            │
├─────────────────────────────────────────┤
│ 4. CLI 参考                              │
│    可用的 moltbot 命令                     │
├─────────────────────────────────────────┤
│ 5. 技能(Skills)                          │
│    从 skills/ 目录加载的专项指令            │
├─────────────────────────────────────────┤
│ 6. 记忆(Memory)                          │
│    如何使用 memory_search/memory_get       │
├─────────────────────────────────────────┤
│ 7. 工作空间信息                            │
│    当前工作目录、可访问的文件                │
├─────────────────────────────────────────┤
│ 8. 用户身份                              │
│    主人的联系方式，用于鉴权                  │
├─────────────────────────────────────────┤
│ 9. 时区                                  │
│    当前时区（影响时间相关回答）              │
├─────────────────────────────────────────┤
│ 10. 渠道特殊指令                          │
│     Telegram 的回复标签、Slack 的线程模式    │
├─────────────────────────────────────────┤
│ 11. 推理格式                             │
│     <think>...</think> + <final>...</final>│
├─────────────────────────────────────────┤
│ 12. 运行时信息                            │
│     主机名、模型名、渠道、能力              │
├─────────────────────────────────────────┤
│ 13. 项目上下文                            │
│     注入的 SOUL.md 等自定义指令文件         │
└─────────────────────────────────────────┘
```

### 3.3 工具注册与策略过滤

**文件**: `src/agents/pi-tools.ts`

Agent 可以使用的工具需要经过多层过滤：

```
所有可用工具
    │
    ▼
┌──────────────────┐
│  基础工具          │  read, write, edit, grep, find, ls, exec
│  (来自 pi-coding)  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Moltbot 工具     │  message, web_search, web_fetch, browser,
│  (自定义)         │  sessions_send, image, gateway_restart, ...
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  插件工具          │  由扩展注册的额外工具
└────────┬─────────┘
         │
    策略过滤层
         │
    ┌────┼────┬────┬────┬────┬────┐
    ▼    ▼    ▼    ▼    ▼    ▼    ▼
  Auth  Provider Global Agent Group Sandbox Subagent
  策略   策略    策略   策略   策略   策略    策略

最终可用工具 = 通过所有策略过滤后的工具集合
```

每个策略可以有 `allow`（白名单）和 `deny`（黑名单）规则。

### 3.4 会话历史加载

**文件**: `src/agents/pi-embedded-runner/run/attempt.ts`

```
会话文件（JSONL 格式）
    │
    ▼
加载历史对话记录
    │
    ▼
清理敏感信息（如 API Key）
    │
    ▼
校验对话轮次（user → assistant → user 交替）
    │
    ▼
限制历史长度（防止超出上下文窗口）
    │
    ▼
注入到 Agent 的消息列表中
```

### 3.5 发送请求给大模型

这是实际调用 AI API 的步骤。以 Anthropic Claude 为例：

```json
// 发送给 Anthropic API 的请求（简化版）
{
  "model": "claude-opus-4-5-20251101",
  "max_tokens": 8192,
  "system": "你是一个运行在 Moltbot 中的个人助手...",
  "messages": [
    // 历史对话
    { "role": "user", "content": "昨天我让你查的资料找到了吗？" },
    { "role": "assistant", "content": "找到了，关于..." },
    // 当前消息
    { "role": "user", "content": "帮我搜一下今天北京的天气" }
  ],
  "tools": [
    {
      "name": "web_search",
      "description": "搜索互联网获取信息",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" }
        }
      }
    },
    {
      "name": "message",
      "description": "发送消息到聊天渠道",
      "input_schema": { ... }
    }
    // ...更多工具
  ],
  "stream": true  // 启用流式响应
}
```

### 3.6 流式响应处理

**文件**: `src/agents/pi-embedded-runner/subscribe.ts`

AI 的回复是流式到达的（一个字一个字出来），系统需要实时处理：

```
AI API 流式响应
    │
    ├──→ text_delta 事件
    │    "今天"  "北京"  "天气"  "是"  "晴天"  ...
    │    │
    │    ▼
    │    累积到 blockBuffer
    │    │
    │    ▼
    │    触发 onPartialReply（实时推送给用户端）
    │
    ├──→ tool_use 事件
    │    AI 想调用 web_search 工具
    │    │
    │    ▼
    │    执行工具：
    │    web_search({ query: "北京今天天气" })
    │    │
    │    ▼
    │    返回搜索结果给 AI
    │    │
    │    ▼
    │    AI 继续生成回复
    │
    ├──→ thinking 事件（如果开启推理模式）
    │    <think>用户想知道天气，我需要搜索...</think>
    │    │
    │    ▼
    │    记录但不一定展示给用户
    │
    └──→ message_stop 事件
         AI 完成回复
         │
         ▼
         组装最终 payloads
```

### 3.7 工具调用循环

当 AI 需要使用工具时，会形成一个循环：

```
┌─────────────────────────────────────────────────────┐
│                    工具调用循环                        │
│                                                      │
│  提交 Prompt ──→ AI 思考 ──→ AI 决定调用工具          │
│       ▲                           │                  │
│       │                           ▼                  │
│       │                    执行工具（本地）             │
│       │                    例如：web_search            │
│       │                           │                  │
│       │                           ▼                  │
│       │                    获取工具结果                │
│       │                           │                  │
│       └───── 把结果发回给 AI ◄─────┘                  │
│                                                      │
│  循环直到 AI 返回 stop_reason = "end_turn"            │
│  （即 AI 认为任务完成，不再需要调用工具）                │
└─────────────────────────────────────────────────────┘
```

**具体例子**：

```
用户: "帮我查一下 OpenAI 的最新博客并总结"

第 1 轮:
  User → AI:  "帮我查一下 OpenAI 的最新博客并总结"
  AI → Tool:  web_search({ query: "OpenAI latest blog 2026" })
  Tool → AI:  { results: [{ url: "https://openai.com/blog/...", title: "..." }] }

第 2 轮:
  AI → Tool:  web_fetch({ url: "https://openai.com/blog/..." })
  Tool → AI:  { content: "今天 OpenAI 宣布了..." }

第 3 轮:
  AI → User:  "OpenAI 最新博客的内容摘要如下：..."
  stop_reason: "end_turn"  ← 循环结束
```

---

## 第四阶段：响应组装与投递

### 4.1 响应组装

**文件**: `src/agents/pi-embedded-runner/run/payloads.ts`

AI 的原始响应需要被组装成可投递的格式：

```
原始响应内容
    │
    ▼
┌──────────────────────────────────┐
│ 组装逻辑（按顺序）                 │
│                                  │
│ 1. 错误文本（如果有错误发生）       │
│ 2. 工具调用结果（如果 verbose 模式）│
│ 3. 推理内容（如果推理模式开启）      │
│ 4. 主回复文本（AI 的最终回答）      │
│ 5. 媒体附件（图片/文件 URL）       │
└──────────┬───────────────────────┘
           │
           ▼
     Payload 列表
     [
       { text: "...", mediaUrl: null, replyToId: "msg123" },
       { text: null, mediaUrl: "image.png", replyToId: null }
     ]
```

### 4.2 回复分块

**文件**: `src/auto-reply/chunk.ts`

不同平台有不同的消息长度限制：

```
平台消息长度限制：
  Telegram:  4000 字符
  Discord:   2000 字符
  Slack:     40000 字符
  WhatsApp:  65536 字符
  Signal:    ~6000 字符

如果 AI 回复超过限制，需要智能分块：
  - 按段落边界分割
  - 代码块不在中间断开
  - 列表项保持完整
  - 每块独立可读
```

### 4.3 投递到渠道

```
分块后的回复
    │
    ▼
渠道出站适配器 (ChannelOutboundAdapter)
    │
    ├── Telegram: 调用 Telegram Bot API 的 sendMessage
    ├── Discord:  调用 Discord API 的 createMessage
    ├── Slack:    调用 Slack Web API 的 chat.postMessage
    ├── Signal:   调用 signal-cli 发送
    └── ...
    │
    ▼
用户在聊天平台看到回复
```

---

## 第五阶段：错误处理与容错

### 5.1 错误分类

```
错误类型                    处理方式
─────────                  ──────────
上下文溢出                  → 自动压缩对话历史，重试
(context_overflow)

认证失败                    → 切换到下一个 Auth Profile
(auth_error)

限流                       → 标记冷却期，切换 Profile
(rate_limit)

超时                       → 标记冷却期，重试
(timeout)

推理模式不支持               → 降级到 "low" 或 "off"，重试
(thinking_unsupported)

对话轮次错误                 → 修复历史记录，友好提示
(role_ordering)

所有 Profile 耗尽            → 触发模型降级（Fallback）
(all_profiles_exhausted)

所有降级模型都失败            → 返回错误信息给用户
(all_fallbacks_failed)
```

### 5.2 上下文压缩

**文件**: `src/agents/compaction.ts`

当对话历史太长，超过模型的上下文窗口时：

```
压缩流程：

1. 把历史消息分成 N 个块（每块占上下文的 ~40%）
2. 对每个块调用 AI 生成摘要
3. 合并所有摘要为一个连贯的总结
4. 用总结替换原始历史消息
5. 重试 Agent 调用

示例：
  原始历史: 100 条消息，~150K tokens
      ↓
  分成 3 块，分别摘要
      ↓
  合并摘要: ~5K tokens
      ↓
  压缩后历史: 摘要 + 最近 10 条消息
```

---

## 关键数据结构

### Agent 运行结果

```typescript
type EmbeddedPiRunResult = {
  payloads: Array<{
    text: string | null;      // 回复文本
    mediaUrl: string | null;  // 媒体附件
    isError: boolean;         // 是否为错误消息
    replyToId?: string;       // 回复特定消息
  }>;
  meta: {
    durationMs: number;       // 执行耗时（毫秒）
    agentMeta: {
      sessionId: string;      // 会话 ID
      provider: string;       // 使用的提供商（如 "anthropic"）
      model: string;          // 使用的模型（如 "claude-opus-4-5"）
      usage: {                // Token 用量
        inputTokens: number;
        outputTokens: number;
      };
    };
    aborted: boolean;         // 是否被中止
    error?: string;           // 错误类型
  };
  didSendViaMessagingTool: boolean;  // AI 是否通过 message 工具主动发了消息
};
```

### 会话文件格式 (JSONL)

```jsonl
{"role":"user","content":"你好"}
{"role":"assistant","content":"你好！有什么可以帮你的？"}
{"role":"user","content":"帮我搜一下天气"}
{"role":"assistant","content":[{"type":"tool_use","name":"web_search","input":{"query":"天气"}}]}
{"role":"tool","content":"搜索结果..."}
{"role":"assistant","content":"今天天气晴朗..."}
```

---

## 多 Agent 支持

Moltbot 支持配置多个 Agent，每个 Agent 有独立的：

```
Agent 1 (default)          Agent 2 (writer)          Agent 3 (coder)
├── 独立的模型配置          ├── 独立的模型配置          ├── 独立的模型配置
├── 独立的系统提示词        ├── 独立的系统提示词        ├── 独立的系统提示词
├── 独立的工具集            ├── 独立的工具集            ├── 独立的工具集
├── 独立的对话历史          ├── 独立的对话历史          ├── 独立的对话历史
└── 独立的工作空间          └── 独立的工作空间          └── 独立的工作空间

Agent 之间可以通过 sessions_send 工具互发消息
```

---

## 与主流方案的对比

| 特性 | Moltbot | 普通 ChatBot | LangChain |
|------|---------|-------------|-----------|
| 多渠道 | 15+ 平台统一接入 | 通常单平台 | 无内置 |
| 多模型 | 自动降级 + 轮转 | 单模型 | 需手写 |
| 工具调用 | 内置 20+ 工具 + 插件扩展 | 简单 | 框架支持 |
| 流式响应 | 原生支持 + 分块投递 | 取决于实现 | 支持 |
| 对话持久化 | 文件系统 JSONL | 内存 | 需手写 |
| 上下文压缩 | 自动摘要 | 无 | 需手写 |
| 认证轮转 | 多 Key 冷却机制 | 单 Key | 无 |

---

## 下一步阅读

- [04-detailed-design.md](./04-detailed-design.md) — 详细设计文档
