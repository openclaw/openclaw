# OpenClaw 如何在 pi-mono 框架基础上扩展

## 一、pi-mono 框架概述

[pi-mono](https://github.com/badlogic/pi-mono) 是 Mario Zechner 开发的 AI 编程智能体框架，以 monorepo 形式组织，发布为 4 个 `@mariozechner/` npm 包：

| 包名 | 当前版本 | 职责 |
|------|---------|------|
| `pi-agent-core` | 0.55.1 | 智能体循环引擎、工具执行框架、`AgentMessage`/`AgentTool` 核心类型 |
| `pi-ai` | 0.55.1 | LLM 抽象层：`Model` 接口、`streamSimple` 流式调用、消息类型、多提供商 API 适配 |
| `pi-coding-agent` | 0.55.1 | 高级 SDK：`createAgentSession()`、`SessionManager`、`AuthStorage`、`ModelRegistry`、内置编码工具（read/bash/edit/write） |
| `pi-tui` | 0.55.1 | 终端 UI 组件（交互式 TUI 渲染） |

pi-mono 的核心能力是：**提供一个完整的 LLM 驱动编码智能体循环**——接收用户输入、调用 LLM、执行工具、流式输出、管理会话历史。它本身是一个终端应用（`pi` CLI），通过 TUI 与用户交互。

---

## 二、嵌入式集成模式

### 为什么不是 fork / 子进程 / RPC？

OpenClaw 需要在智能体运行时的**每一个环节**注入自定义逻辑：

- 工具集需要按渠道/用户/安全策略动态裁决
- 系统提示需要按上下文（渠道、群组、沙箱）动态构建
- 会话事件需要实时转化为消息渠道的回复
- 认证需要多配置轮换和故障转移

Fork 意味着维护成本爆炸；子进程/RPC 意味着丢失细粒度控制。因此 OpenClaw 选择**嵌入式集成**：直接 `import` pi-mono 的 SDK 包，在进程内实例化 `AgentSession`，获得对智能体生命周期的完全控制。

### 代码入口点

```
用户消息 → 渠道层 → 路由引擎 → runEmbeddedPiAgent()
                                       │
                    src/agents/pi-embedded-runner/run.ts
                                       │
                                       ▼
                              runEmbeddedAttempt()
                    src/agents/pi-embedded-runner/run/attempt.ts
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
           createAgentSession()   系统提示构建      工具集组装
           (pi-coding-agent)     (OpenClaw 自建)   (OpenClaw 自建)
                    │
                    ▼
            session.prompt()  ←── pi-mono 接管智能体循环
                    │
                    ▼
         subscribeEmbeddedPiSession()  ←── OpenClaw 订阅事件流
           src/agents/pi-embedded-subscribe.ts
```

关键代码（`src/agents/pi-embedded-runner/run/attempt.ts`）：

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

// 1. 创建会话
const { session } = await createAgentSession({
  cwd: resolvedWorkspace,
  agentDir,
  authStorage: params.authStorage,
  modelRegistry: params.modelRegistry,
  model: params.model,
  tools: builtInTools,          // 空数组 — OpenClaw 接管所有工具
  customTools: allCustomTools,  // OpenClaw 的完整工具集
  sessionManager,
  settingsManager,
  resourceLoader,
});

// 2. 注入 OpenClaw 的系统提示
applySystemPromptOverrideToSession(session, systemPromptOverride);

// 3. 订阅事件流（转化为消息渠道回复）
const subscription = subscribeEmbeddedPiSession({ session, ... });

// 4. 启动智能体循环（pi-mono 接管）
await session.prompt(effectivePrompt, { images });
```

---

## 三、7 大扩展维度

### 1. 工具系统完全替换

**pi-mono 提供的**：`codingTools`（read、bash、edit、write）——面向终端编码场景的基础文件操作工具。

**OpenClaw 的改造**：

- **清空内置工具**：`splitSdkTools()` 将 `builtInTools` 设为空数组，所有工具通过 `customTools` 注入，确保 OpenClaw 的策略过滤和沙箱集成一致覆盖所有工具。

- **替换基础工具**：bash 替换为 `exec`/`process`（支持沙箱执行和进程管理），read/edit/write 替换为沙箱感知版本（通过 `createSandboxedReadTool()` 等）。

- **新增 20+ 专属工具**（`src/agents/openclaw-tools.ts`）：

  | 工具 | 职责 |
  |------|------|
  | `message` | 向任意渠道/会话发送消息 |
  | `browser` | 网页浏览和截图 |
  | `canvas` | 画布/可视化工具 |
  | `cron` | 定时任务调度 |
  | `sessions_spawn` | 生成子智能体 |
  | `sessions_list/history/send` | 会话管理 |
  | `tts` | 文本转语音 |
  | `image` | 图像生成 |
  | `web_fetch/web_search` | 网络检索 |
  | `gateway` | 网关管理 |
  | `agents_list/subagents` | 智能体管理 |
  | `nodes` | 远程节点管理 |

- **渠道专属工具**：`telegram_actions`、`discord_actions`、`slack_actions`、`whatsapp_actions` 等——让智能体能执行平台特定操作（发送反应、管理频道、修改群组设置等）。

- **多层工具策略**（`src/agents/pi-tools.policy.ts`）：

  ```
  Owner-only 限制     → 危险工具仅属主可用
  渠道策略            → 语音渠道禁用 TTS
  模型策略            → apply_patch 仅限特定模型
  子智能体深度策略     → 叶子节点禁止 spawn
  群组策略            → 群组级别工具白名单/黑名单
  沙箱策略            → 文件系统 deny/allow glob
  工具循环检测         → 防止工具无限递归
  ```

- **工具签名适配**（`src/agents/pi-tool-definition-adapter.ts`）：pi-agent-core 的 `AgentTool.execute` 和 pi-coding-agent 的 `ToolDefinition.execute` 签名不同，适配器桥接了这一差异。

**设计意图**：pi-mono 的工具面向"单用户终端编码"；OpenClaw 需要"多用户、多渠道、安全隔离"的工具体系。完全替换而非扩展，是因为安全策略必须一致覆盖——不能有漏网的内置工具绕过策略。

---

### 2. 多渠道消息网关

**pi-mono 提供的**：`pi-tui` 终端 TUI 交互——单用户、单终端。

**OpenClaw 的扩展**：

- **15+ 消息渠道**：核心渠道（Telegram、Discord、Slack、Signal、iMessage、WhatsApp、IRC、Google Chat）+ 扩展渠道（Matrix、Teams、Zalo、语音通话等），全部实现统一的 `ChannelPlugin` 接口。

- **7 级优先级路由引擎**（`src/routing/resolve-route.ts`）：

  ```
  1. binding.peer          → 精确对等体匹配
  2. binding.peer.parent   → 线程父对等体回退
  3. binding.guild+roles   → Discord 服务器 + 角色
  4. binding.guild         → Discord 服务器级别
  5. binding.team          → Teams 组织级别
  6. binding.account       → 账户级别默认
  7. binding.channel       → 渠道级别兜底
  → default               → 系统默认智能体
  ```

- **消息缓冲/去抖层**：Telegram 媒体组合并、文本分片合并、可配置去抖延迟——屏蔽平台传输差异。

- **异步回复派发**（`src/auto-reply/reply/reply-dispatcher.ts`）：ToolResult → BlockReply → FinalReply 有序队列，全局 `DispatcherRegistry` 追踪活跃派发器以支持优雅关闭。

- **接入控制**：AllowList + Pairing 配对机制 + MentionGating + CommandGating。

**设计意图**：pi-mono 解决"人与 LLM 在终端对话"；OpenClaw 解决"人通过任意即时通讯平台与 LLM 智能体对话"。这要求在 pi-mono 的智能体循环之上，新建一整套消息接收、路由、分发、回复的基础设施。

---

### 3. 系统提示词动态构建

**pi-mono 提供的**：静态 `AGENTS.md` + prompts 目录——加载磁盘文件作为系统提示。

**OpenClaw 的改造**（`src/agents/system-prompt.ts`）：

- **动态组装 20+ 节段**：`buildAgentSystemPrompt()` 根据运行上下文组装提示，包含：

  | 节段 | 内容 |
  |------|------|
  | Identity | 智能体身份声明 |
  | Tooling | 可用工具及使用规则 |
  | Tool Call Style | 工具调用格式约束 |
  | Safety | 安全护栏 |
  | CLI Reference | OpenClaw CLI 快速参考 |
  | Skills | 可用技能及选择规则 |
  | Docs | 工作区文档引用 |
  | Workspace | 工作目录信息 |
  | Sandbox | 沙箱环境描述 |
  | Messaging | 消息发送规则 |
  | Reply Tags | 回复指令标签 |
  | Voice | 语音交互提示 |
  | Silent Replies | 静默回复令牌 |
  | Heartbeats | 心跳机制 |
  | Runtime | 运行时元数据 |
  | Memory | 记忆检索指令 |
  | Reactions | 反应功能 |
  | Context Files | 上下文文件注入 |

- **三种提示模式**：
  - `"full"`：主智能体，所有节段
  - `"minimal"`：子智能体，仅 Tooling + Workspace + Runtime
  - `"none"`：仅基本身份行

- **渠道感知**：不同渠道注入不同的消息规则（Telegram 内联按钮、Slack 自动线程、Discord 反应等级等）。

- **注入时机**：会话创建后，通过 `applySystemPromptOverrideToSession()` 覆盖 pi-mono 的默认系统提示。

**设计意图**：pi-mono 的静态提示适合固定场景；OpenClaw 面对多渠道、多智能体、多安全级别的组合爆炸，必须动态构建。

---

### 4. 认证与模型管理增强

**pi-mono 提供的**：`AuthStorage` + `ModelRegistry`——单凭证、单提供商的基础认证和模型注册。

**OpenClaw 的扩展**：

- **多认证配置轮换**（`src/agents/auth-profiles.ts`）：

  ```typescript
  // 解析配置优先级顺序
  const profileOrder = resolveAuthProfileOrder({ cfg, store, provider });

  // 标记失败并触发 cooldown
  await markAuthProfileFailure({ store, profileId, reason });

  // 自动轮换到下一个可用配置
  const rotated = await advanceAuthProfile();
  ```

  - `AuthProfileStore`：持久化存储多个 API key/OAuth 凭证
  - Cooldown 机制：失败的配置进入冷却期，避免重复尝试
  - 自动轮换：当前配置失败时自动切换到下一个

- **故障转移**（`src/agents/failover-error.ts`）：

  ```typescript
  // 错误分类
  classifyFailoverReason(errorText)  // → "auth" | "rate_limit" | "quota" | "timeout" | ...

  // 触发 failover
  throw new FailoverError(errorText, { reason, provider, model, status });
  ```

  - 区分认证错误、速率限制、配额耗尽、超时等原因
  - 根据错误类型决定是轮换配置、切换模型还是放弃

- **多提供商支持**：Anthropic、OpenAI、Google/Gemini、Ollama、BytePlus、Chutes 等，每个提供商有特定的兼容性处理：
  - Anthropic：拒绝魔术字符串清洗、连续角色轮次校验
  - Google/Gemini：轮次排序修复、工具 schema 清洗、会话历史清洗
  - OpenAI：`apply_patch` 工具支持、思考级别降级

- **思考级别降级**：如果请求的思考级别不被模型支持，自动降级：

  ```typescript
  const fallbackThinking = pickFallbackThinkingLevel({
    message: errorText,
    attempted: attemptedThinking,
  });
  ```

**设计意图**：pi-mono 面向个人开发者（一个 API key 即可）；OpenClaw 作为多用户网关，需要抗故障（key 限速/过期时自动切换）和多提供商灵活性。

---

### 5. 会话管理增强

**pi-mono 提供的**：`SessionManager`——JSONL 格式的树状会话存储（id/parentId 链接），支持分支和压缩。

**OpenClaw 的扩展**：

- **路径体系重建**：
  ```
  pi-mono:    ~/.pi/agent/sessions/
  OpenClaw:   ~/.openclaw/agents/<agentId>/sessions/
  ```
  支持多智能体各自独立的会话空间。

- **SessionManager 缓存**（`src/agents/pi-embedded-runner/session-manager-cache.ts`）：
  ```typescript
  await prewarmSessionFile(params.sessionFile);      // 预热
  sessionManager = SessionManager.open(sessionFile); // 缓存实例
  trackSessionManagerAccess(sessionFile);             // 追踪访问
  ```
  避免重复解析大型 JSONL 文件。

- **会话写锁**（`src/agents/session-write-lock.ts`）：防止并发写入同一会话文件。

- **历史限制**（`src/agents/pi-embedded-runner/history.ts`）：按渠道类型（DM vs 群组）限制对话历史长度。

- **压缩保护扩展**（`src/agents/pi-extensions/compaction-safeguard.ts`）：
  - 自适应 token 预算
  - 工具失败和文件操作摘要保留
  - 防止压缩丢失关键上下文

- **上下文修剪扩展**（`src/agents/pi-extensions/context-pruning.ts`）：
  - 基于 cache-TTL 的上下文修剪
  - 长时间未命中缓存的内容自动修剪

- **Bootstrap 文件系统**（`src/agents/bootstrap-files.ts`）：
  加载工作区的 `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md` 作为上下文注入。

- **会话工具结果保护**（`src/agents/session-tool-result-guard-wrapper.ts`）：
  `guardSessionManager()` 包装 SessionManager，确保工具结果安全写入。

**设计意图**：pi-mono 的会话管理面向"单用户单会话"；OpenClaw 的多智能体、多会话并发场景需要缓存、锁、限制、保护等生产级增强。

---

### 6. 插件生态系统

**pi-mono 提供的**：Extension 机制——从磁盘加载扩展，注入到 `ResourceLoader`。

**OpenClaw 的扩展**（`src/plugins/types.ts`）：

- **完整的插件 API**（`OpenClawPluginApi`）— 10 种注册能力：

  | 方法 | 注册内容 |
  |------|---------|
  | `registerTool()` | 智能体工具 |
  | `registerHook()` / `on()` | 生命周期钩子 |
  | `registerHttpHandler()` | HTTP 中间件 |
  | `registerHttpRoute()` | HTTP 路由 |
  | `registerChannel()` | 消息渠道 |
  | `registerGatewayMethod()` | 网关 RPC 方法 |
  | `registerCli()` | CLI 命令 |
  | `registerService()` | 后台服务 |
  | `registerProvider()` | 认证/模型提供者 |
  | `registerCommand()` | 插件命令（绕过 LLM） |

- **24 个生命周期钩子**：

  ```
  模型解析阶段:    before_model_resolve
  提示构建阶段:    before_prompt_build, before_agent_start
  LLM 交互阶段:   llm_input, llm_output
  智能体阶段:      agent_end
  压缩阶段:        before_compaction, after_compaction
  会话阶段:        before_reset, session_start, session_end
  消息阶段:        message_received, message_sending, message_sent
  工具阶段:        before_tool_call, after_tool_call, tool_result_persist
  写入阶段:        before_message_write
  子智能体阶段:    subagent_spawning, subagent_delivery_target, subagent_spawned, subagent_ended
  网关阶段:        gateway_start, gateway_stop
  ```

- **插件来源**（`src/plugins/discovery.ts`）：
  - `bundled`：内置插件（`extensions/` 目录下随仓库发布）
  - `global`：全局安装的 npm 包
  - `workspace`：工作区本地插件
  - `config`：配置文件中指定的插件

- **实际插件生态**（`extensions/` 目录）：

  | 插件 | 类型 | 职责 |
  |------|------|------|
  | `msteams` | 渠道 | Microsoft Teams 集成 |
  | `matrix` | 渠道 | Matrix 协议集成 |
  | `zalo/zalouser` | 渠道 | Zalo 集成 |
  | `voice-call` | 渠道 | 语音通话 |
  | `bluebubbles` | 渠道 | BlueBubbles (iMessage) |
  | `memory-core` | 功能 | 记忆系统核心 |
  | `memory-lancedb` | 功能 | LanceDB 向量记忆 |
  | `diagnostics-otel` | 功能 | OpenTelemetry 诊断 |
  | `provider-*` | 提供者 | 各 LLM 提供商集成 |

**设计意图**：pi-mono 的扩展机制是"加载额外的磁盘文件"；OpenClaw 需要的是"插件可以改变系统的任何行为"——从工具注入到 HTTP 路由到渠道注册。这要求从扩展（Extension）升级为插件（Plugin），提供全面的 API 和钩子。

---

### 7. 子智能体编排

**pi-mono 提供的**：基本的智能体循环——一个会话、一个循环、一个执行流。

**OpenClaw 的扩展**：

- **两种子智能体运行时**：
  - `subagent`：进程内轻量级子智能体，共享内存空间
  - `acp`（Agent Communication Protocol，`src/agents/acp-spawn.ts`）：跨进程智能体通信

- **两种运行模式**：
  - `run`：一次性执行，完成后自动向父智能体报告结果
  - `session`：持久会话，绑定到线程/话题，可接收后续消息

- **深度控制**（`src/agents/pi-tools.policy.ts`）：

  ```typescript
  // 始终禁止的工具（任何深度的子智能体）
  const SUBAGENT_TOOL_DENY_ALWAYS = [
    "gateway", "agents_list",        // 系统管理
    "whatsapp_login",                // 交互式设置
    "session_status", "cron",        // 状态/调度
    "memory_search", "memory_get",   // 记忆（应通过 spawn 提示传递）
    "sessions_send",                 // 直接发送（应通过 announce 链传递）
  ];

  // 叶子节点额外禁止的工具
  const SUBAGENT_TOOL_DENY_LEAF = [
    "sessions_list", "sessions_history", "sessions_spawn"
  ];
  ```

  - **编排者**（depth 1，maxSpawnDepth >= 2）：可以 spawn 子任务、管理子会话
  - **叶子节点**（depth >= maxSpawnDepth）：只能执行具体任务，不能再 spawn

- **子智能体生命周期钩子**：`subagent_spawning` → `subagent_delivery_target` → `subagent_spawned` → `subagent_ended`，插件可以在每个阶段介入。

**设计意图**：复杂的用户请求需要分解（"帮我同时在 3 个渠道发布公告"），但不受控的 spawn 会导致资源爆炸。深度控制 + 工具权限分层确保"可分工但不失控"。

---

## 四、pi-mono vs OpenClaw 对比总表

| 维度 | pi-mono（基座） | OpenClaw（扩展） |
|------|----------------|-----------------|
| **定位** | AI 编码智能体 CLI 工具 | 多渠道 AI 智能体网关平台 |
| **调用方式** | `pi` 命令 / RPC | 嵌入式 SDK（`createAgentSession()`） |
| **交互界面** | 终端 TUI | 15+ 即时通讯渠道 |
| **工具集** | read/bash/edit/write（4 个） | 完全替换 + 20 多个专属工具 |
| **工具安全** | 无策略层 | 6 层策略叠加 |
| **系统提示** | 静态 AGENTS.md | 20+ 节段动态组装，3 种模式 |
| **认证** | 单凭证 | 多配置轮换 + cooldown + failover |
| **提供商** | 基础多提供商 | 深度适配 6+ 提供商特性 |
| **会话存储** | `~/.pi/agent/sessions/` | `~/.openclaw/agents/<id>/sessions/` + 缓存/锁/修剪 |
| **扩展机制** | Extension（磁盘加载） | Plugin API（10 注册点 + 24 钩子） |
| **子智能体** | 无 | subagent + ACP，深度控制 |
| **事件处理** | TUI 渲染 | 回调驱动（`onBlockReply` 等） |
| **部署形态** | 终端应用 | 网关服务 + menubar 应用 + CLI |

---

## 五、架构关系图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OpenClaw 应用层                               │
│                                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  ┌───────────┐ │
│  │ 消息渠道层    │  │ 插件生态系统   │  │ CLI / 网关  │  │ Web UI    │ │
│  │ (15+ 渠道)   │  │ (30+ 插件)    │  │            │  │           │ │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘  └─────┬─────┘ │
│         │                │                │                │       │
│  ┌──────┴────────────────┴────────────────┴────────────────┴─────┐ │
│  │                    OpenClaw 核心层                              │ │
│  │                                                               │ │
│  │  路由引擎 │ 工具策略 │ 系统提示构建 │ 认证轮换 │ 会话增强 │ 子智能体  │ │
│  └───────────────────────────┬───────────────────────────────────┘ │
│                              │                                     │
│  ┌───────────────────────────┴───────────────────────────────────┐ │
│  │                  嵌入式集成层（Embedded Integration）            │ │
│  │                                                               │ │
│  │  runEmbeddedPiAgent() → createAgentSession() → session.prompt()│ │
│  │  subscribeEmbeddedPiSession() → 事件回调                       │ │
│  │  splitSdkTools() → builtIn=[] + customTools=OpenClaw工具集      │ │
│  │  applySystemPromptOverrideToSession() → 覆盖系统提示            │ │
│  └───────────────────────────┬───────────────────────────────────┘ │
└──────────────────────────────┼───────────────────────────────────────┘
                               │
┌──────────────────────────────┴───────────────────────────────────────┐
│                        pi-mono 框架层                                 │
│                                                                      │
│  ┌──────────────────┐  ┌───────────────┐  ┌────────────────────────┐│
│  │  pi-agent-core   │  │    pi-ai      │  │   pi-coding-agent      ││
│  │                  │  │               │  │                        ││
│  │  · AgentMessage  │  │  · Model      │  │  · createAgentSession  ││
│  │  · AgentTool     │  │  · streamSimple│  │  · SessionManager     ││
│  │  · 工具执行引擎   │  │  · 消息类型    │  │  · AuthStorage         ││
│  │  · 智能体循环     │  │  · 提供商 API  │  │  · ModelRegistry       ││
│  │                  │  │               │  │  · ResourceLoader      ││
│  └──────────────────┘  └───────────────┘  └────────────────────────┘│
│                                                                      │
│  ┌──────────────────┐                                                │
│  │     pi-tui       │  ← OpenClaw 仅在本地 TUI 模式下使用             │
│  │  · 终端 UI 组件   │                                                │
│  └──────────────────┘                                                │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 六、总结

OpenClaw 与 pi-mono 的关系可以概括为：

> **pi-mono 提供了"LLM 驱动的智能体循环引擎"这一核心能力——模型调用、工具执行、会话管理、流式输出。OpenClaw 在此基础上，通过嵌入式集成获得对智能体生命周期的完全控制，然后在 7 个维度上进行深度扩展，将 pi-mono 从一个"终端编码助手"转变为一个"多渠道、多智能体、可插拔、生产级的 AI 网关平台"。**

pi-mono 是引擎，OpenClaw 是整车。引擎提供动力（智能体循环），整车提供方向盘（路由）、变速箱（工具策略）、仪表盘（渠道 UI）、安全系统（认证轮换/沙箱）和拖车能力（子智能体编排）。
