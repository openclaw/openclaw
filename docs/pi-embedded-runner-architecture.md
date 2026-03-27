# Pi Embedded Runner — Agent 架构分析

> 基于 `src/agents/pi-embedded-runner/run.ts` 及相关模块整理。

---

## 整体分层结构

```
┌─────────────────────────────────────────────────────────────────┐
│                    外部调用层 (Caller)                           │
│         消息频道 / CLI / API / Web Provider                      │
└─────────────────────┬───────────────────────────────────────────┘
                      │ RunEmbeddedPiAgentParams
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              run.ts  —  runEmbeddedPiAgent()                    │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Lane 队列    │  │  认证管理     │  │   模型解析              │ │
│  │             │  │              │  │                        │ │
│  │ sessionLane │  │ authProfiles │  │ resolveModel()         │ │
│  │ globalLane  │  │ profileOrder │  │ effectiveModel         │ │
│  │             │  │ lockedProfile│  │ contextWindowGuard     │ │
│  └─────────────┘  └──────────────┘  └────────────────────────┘ │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              主重试循环 (while true)                      │   │
│  │                                                         │   │
│  │  runLoopIterations < MAX_RUN_LOOP_ITERATIONS            │   │
│  │                                                         │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │           runEmbeddedAttempt()                   │  │   │
│  │  │           run/attempt.ts                         │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  │                 │ EmbeddedRunAttemptResult              │   │
│  │                 ▼                                       │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │           错误分类 & 循环决策                      │  │   │
│  │  │                                                  │  │   │
│  │  │  contextOverflow → compact() → continue          │  │   │
│  │  │  authFailure     → advanceAuthProfile() → cont   │  │   │
│  │  │  rateLimitFailure→ advanceAuthProfile() → cont   │  │   │
│  │  │  thinkingError   → fallbackThinkingLevel → cont  │  │   │
│  │  │  timedOut        → rotate profile → continue     │  │   │
│  │  │  overload        → backoff + rotate → continue   │  │   │
│  │  │  retryLimit      → return error                  │  │   │
│  │  │  success         → break → return result         │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 主重试循环的决策流程

```
while (true) {
    runLoopIterations++
    if (runLoopIterations >= MAX) → return RetryLimitError
         │
         ▼
    runEmbeddedAttempt()
         │
         ├─ contextOverflowError?
         │       ├─ 有 in-attempt 压缩 → continue (最多3次)
         │       ├─ 无压缩 → contextEngine.compact() → continue
         │       ├─ 有 oversized tool result → truncate → continue
         │       └─ 超出上限 → return ContextOverflowError
         │
         ├─ promptError? (非 overflow)
         │       ├─ Copilot auth error → refreshCopilotToken → continue
         │       ├─ role ordering error → return RoleOrderingError
         │       ├─ image size error → return ImageSizeError
         │       ├─ failover 类错误 → advanceAuthProfile → continue
         │       └─ thinking 不支持 → fallbackThinkingLevel → continue
         │
         ├─ fallbackThinking needed? → thinkLevel = fallback → continue
         │
         ├─ authFailure / rateLimitFailure / billingFailure / timedOut?
         │       ├─ markAuthProfileFailure
         │       ├─ advanceAuthProfile() → backoff → continue
         │       └─ 无备用 profile + fallbackConfigured → throw FailoverError
         │
         └─ 成功!
                 ├─ markAuthProfileGood
                 ├─ markAuthProfileUsed
                 └─ buildEmbeddedRunPayloads → return result
}
```

重试上限计算（`run.ts:resolveMaxRunRetryIterations`）：

```
MAX = clamp(
  BASE(24) + profileCount * PER_PROFILE(8),
  MIN=32,
  MAX=160
)
```

---

## run/attempt.ts 内部结构（单次 Attempt）

```
runEmbeddedAttempt(params)
│
├── 1. 初始化阶段
│       ├─ resolveRunWorkspaceDir()       # 工作区目录解析
│       ├─ initSandboxInfo()              # Sandbox 环境信息
│       ├─ ensureRuntimePluginsLoaded()   # 插件加载
│       └─ process.chdir(workspace)      # 切换工作目录
│
├── 2. 会话管理
│       ├─ ensureSessionManagerCached()  # 会话管理器（含工具集）
│       ├─ guardSessionManager()         # 工具调用/结果验证
│       └─ loadSessionHistory()          # 历史消息加载
│
├── 3. Prompt 构建
│       ├─ detectAndLoadPromptImages()   # 图像检测与加载
│       ├─ before_prompt_build hook      # 插件钩子
│       ├─ contextEngine.bootstrap()     # 上下文引擎引导
│       └─ assembleSystemPrompt()        # 系统提示组装
│
├── 4. 流包装 (Stream Middleware Chain)
│       ├─ wrapStreamFnTrimToolCallNames()     # 工具名规范化
│       ├─ wrapStreamFnXaiStreamDecoding()     # xAI 解码
│       ├─ wrapStreamFnOllamaNumCtxInjection() # Ollama ctx 注入
│       └─ llm_input hook wrapper             # 插件流拦截
│
├── 5. 执行阶段 (核心)
│       ├─ runPrompt() / pi-coding-agent      # LLM API 调用
│       │       └─ 内部 tool-use 循环         # 模型自主工具调用
│       └─ timeout / abort 处理
│
├── 6. 压缩处理
│       ├─ compactionSafetyTimeout()          # 等待压缩完成
│       └─ selectCompactionSnapshot()         # 超时时快照选择
│
├── 7. 后处理
│       ├─ contextEngine.afterTurn()          # 上下文引擎后处理
│       ├─ historyImagePrune()                # 清理历史图像
│       └─ agent_end hook                     # 插件钩子
│
└── → EmbeddedRunAttemptResult
```

---

## 上下文管理体系

```
┌────────────────────────────────────────────────────────────────┐
│                      上下文 Token 预算                          │
│                                                                │
│  resolveContextWindowInfo()                                    │
│       │                                                        │
│       ├─ model.contextWindow (原生，如 200k)                    │
│       ├─ config.contextTokens (用户配置上限)                    │
│       └─ effectiveModel.contextWindow = min(两者)              │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Context Overflow 防护策略 (按优先级)                    │  │
│  │                                                         │  │
│  │  1. 主动截断 tool results                               │  │
│  │     tool-result-truncation.ts                           │  │
│  │     └─ 单结果上限 400K chars                            │  │
│  │     └─ 保留 error/summary 尾部内容                      │  │
│  │                                                         │  │
│  │  2. 检测 oversized tool results                         │  │
│  │     tool-result-context-guard.ts                        │  │
│  │     └─ 估算 token 占用 (char estimator)                 │  │
│  │     └─ 超过 30% 上下文预算视为 oversized                │  │
│  │                                                         │  │
│  │  3. 自动压缩 (contextEngine.compact)                    │  │
│  │     compact.ts / compact.runtime.ts                     │  │
│  │     └─ 压缩历史对话为 summary                           │  │
│  │     └─ 保留 firstKeptEntryId 之后的内容                 │  │
│  │     └─ 最多 MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3 次     │  │
│  │                                                         │  │
│  │  4. 最终兜底                                            │  │
│  │     返回 context_overflow 错误给用户                    │  │
│  └─────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

Usage 累加器设计（避免 token 统计虚高）：

```
UsageAccumulator
  ├─ input / output / cacheRead / cacheWrite / total  ← 累计值（全部轮次）
  └─ lastCacheRead / lastCacheWrite / lastInput        ← 最后一次 API 调用值

toNormalizedUsage()
  └─ total = lastInput + lastCacheRead + lastCacheWrite + accumulated_output
     （用最后一次的 prompt tokens，避免 N 轮 tool-use 时 cacheRead 被放大 N 倍）
```

---

## 认证 Profile 轮转机制

```
profileCandidates = [profileA, profileB, profileC, ...]
       │
       ├─ 初始: profileIndex = 0
       │
       ├─ isProfileInCooldown(candidate)?
       │       ├─ YES + allowTransientCooldownProbe → 探针模式，强制尝试一次
       │       └─ YES (普通) → skip, profileIndex++
       │
       ├─ applyApiKeyInfo(candidate)
       │       └─ GitHub Copilot 特殊处理: GitHub Token → Copilot Token 换取
       │              └─ scheduleCopilotRefresh() 提前5分钟定时刷新
       │
       └─ 失败时 advanceAuthProfile()
               ├─ 跳过 cooldown 中的 profile
               ├─ 重置 thinkLevel = initialThinkLevel
               ├─ 清空 attemptedThinking
               └─ 返回 false 时 → throwAuthProfileFailover()
                       ├─ fallbackConfigured → FailoverError（外层模型降级）
                       └─ 否则 → throw Error（终止）
```

---

## Lane 队列并发控制

```
enqueueSession(task)           # 同一 sessionKey 串行化
    └─ enqueueGlobal(task)     # 全局并发控制 (CommandLane.Main)

Lane 格式:
  sessionLane = "session:<sessionKey>"
  globalLane  = params.lane ?? CommandLane.Main

作用: 防止同一会话的并发请求互相覆盖历史状态
```

---

## 关键数据类型关系

```
RunEmbeddedPiAgentParams
    │ (剔除 provider/model/auth/thinkLevel/lane)
    ▼
EmbeddedRunAttemptParams
    + contextEngine
    + model: Model<Api>          ← @mariozechner/pi-ai
    + authStorage: AuthStorage   ← @mariozechner/pi-coding-agent
    + modelRegistry: ModelRegistry
    │
    ▼
EmbeddedRunAttemptResult
    ├─ assistantTexts: string[]
    ├─ toolMetas: {toolName, meta}[]
    ├─ lastAssistant: AssistantMessage
    ├─ messagesSnapshot: AgentMessage[]
    ├─ attemptUsage: NormalizedUsage
    └─ compactionCount: number
    │
    ▼ (run.ts 聚合多次 attempt)
EmbeddedPiRunResult
    ├─ payloads: [{text, mediaUrl, isError}]
    └─ meta: EmbeddedPiRunMeta
            ├─ agentMeta: EmbeddedPiAgentMeta
            │       ├─ usage（累计，供账单统计）
            │       └─ lastCallUsage（最后一次，用于 UI 显示 totalTokens）
            └─ stopReason / pendingToolCalls
```

---

## 核心设计模式总结

| 模式                | 文件位置                                | 作用                                                               |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| **Lane 队列**       | `lanes.ts` + `process/command-queue.ts` | session 级串行化，防并发写冲突                                     |
| **重试循环**        | `run.ts` `while(true)`                  | 统一处理 overflow/auth/rateLimit/timeout                           |
| **Profile 轮转**    | `auth-profiles.ts`                      | 多账号负载均衡 + cooldown 跳过                                     |
| **Stream 中间件链** | `*-stream-wrappers.ts`                  | 工具名规范化、provider-specific 解码                               |
| **Hook 系统**       | `hook-runner-global.ts`                 | before_model_resolve / before_prompt_build / llm_input / agent_end |
| **Context Engine**  | `context-engine/`                       | bootstrap → assemble → afterTurn 生命周期                          |
| **Compaction**      | `compact.ts`                            | 溢出时压缩历史对话，保留 token 预算                                |
| **Usage 累加器**    | `run.ts` `UsageAccumulator`             | 多轮 tool-use 的 token 统计，lastCallUsage 用于 UI 显示            |

---

## 相关源文件索引

| 文件                                                         | 职责                       |
| ------------------------------------------------------------ | -------------------------- |
| `src/agents/pi-embedded-runner/run.ts`                       | 主入口，重试循环，认证管理 |
| `src/agents/pi-embedded-runner/run/attempt.ts`               | 单次 attempt 完整生命周期  |
| `src/agents/pi-embedded-runner/run/params.ts`                | 运行参数类型               |
| `src/agents/pi-embedded-runner/run/types.ts`                 | attempt 输入/输出类型      |
| `src/agents/pi-embedded-runner/run/payloads.ts`              | 响应负载构建               |
| `src/agents/pi-embedded-runner/types.ts`                     | 对外暴露的结果类型         |
| `src/agents/pi-embedded-runner/lanes.ts`                     | Lane 队列名解析            |
| `src/agents/pi-embedded-runner/compact.ts`                   | 压缩逻辑                   |
| `src/agents/pi-embedded-runner/tool-result-truncation.ts`    | 工具结果截断               |
| `src/agents/pi-embedded-runner/tool-result-context-guard.ts` | oversized 检测             |
| `src/agents/context-window-guard.ts`                         | 上下文窗口守卫             |
| `src/agents/auth-profiles.ts`                                | Profile 轮转与 cooldown    |
| `src/agents/failover-error.ts`                               | FailoverError 定义         |
| `src/context-engine/index.ts`                                | 上下文引擎生命周期 API     |
