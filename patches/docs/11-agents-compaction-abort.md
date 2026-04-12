# Patch 11: 主动式压缩、CLI-provider 路由修正、Abort 信号传播

## 为什么要改 (Why)

### 问题 1: 上下文溢出只能被动处理

在此之前，只有当 API 返回 context overflow 错误时才会触发会话压缩。如果一个成功运行消耗了 95% 的上下文窗口，下一轮几乎必然溢出。缺少主动式压缩机制导致频繁的"成功 → 下一轮溢出 → 被动压缩 → 恢复"循环，影响用户体验。

### 问题 2: CLI-provider fallback 被嵌入式 runner 静默改写

当模型 fallback 选择了 `claude-cli/sonnet`（CLI provider 模型），旧代码将其路由到嵌入式 runner（`runEmbeddedPiAgent`）。嵌入式 runner 通过 alias index 将 `claude-cli/sonnet` 静默改写为 `anthropic/claude-sonnet-4-6`，使用了错误的 provider account pool，返回 "500 No available accounts in group OpenClaw" 错误。

### 问题 3: /stop 中断信号被吞没

用户发送 `/stop` 后，abort signal 被设置但 CLI runner 的 JS 编排层没有在关键点检查 signal 状态。结果是上一个子进程被杀掉后，重试/恢复逻辑继续启动新的子进程，造成 /stop 无法及时生效。followup run 路径更是完全没有传递 `abortSignal`。

### 问题 4: 日志配置读取在 bundle 后失效

`logging/config.ts` 使用 `createRequire` 延迟加载 `../config/config.js` 来读取日志级别配置。tsdown 打包后，`dist/logger-*.js` 无法解析这个相对路径，导致日志级别始终 fallback 到默认值 "info"，忽略用户在 `openclaw.json` 中配置的 `logging.level`。

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `src/agents/pi-embedded-runner/run.ts` | 主动压缩逻辑：成功运行后检查 prompt tokens 占比，超过阈值则压缩；拒绝 CLI-provider refs 进入嵌入式 runner |
| `src/agents/pi-settings.ts` | 新增 `DEFAULT_PROACTIVE_COMPACTION_RATIO` (0.8) 和 `resolveProactiveCompactionRatio` 配置解析 |
| `src/agents/command/attempt-execution.ts` | CLI-provider 模型路由到 `runCliAgent` 而非 `runEmbeddedPiAgent` |
| `src/agents/cli-runner.ts` | AbortError 早期返回，阻止 failover classifier 意外包装 abort 错误 |
| `src/agents/cli-runner/execute.ts` | 新增 `checkAbortSignal` 函数，在每次子进程 spawn 前检查 abort；/compact 期间 abort 传播 |
| `src/auto-reply/reply/agent-runner-execution.ts` | followup run 路径传递 `abortSignal` |
| `src/agents/workspace.ts` | BOOTSTRAP.md 缺失时从文件列表中完全省略（不再显示 [MISSING] 诊断） |
| `src/agents/workspace.test.ts` | 3 个新测试：BOOTSTRAP.md 缺失省略、存在时加载、其他文件仍报 missing |
| `src/logging/config.ts` | 用直接 `fs.readFileSync` 读取 `openclaw.json` 替代 `createRequire` 加载模块 |
| `src/logging/logger.ts` | 移除 fallback 的 `requireConfig` 读取路径 |
| `src/config/schema.base.generated.ts` | 新增 `proactiveTriggerRatio` schema 定义；`cliBackends` 结构简化并重排位置 |
| `src/config/schema.help.ts` | 新增 `proactiveTriggerRatio` 帮助文本 |
| `src/config/types.agent-defaults.ts` | `AgentCompactionConfig` 新增 `proactiveTriggerRatio` 字段 |
| `src/config/zod-schema.agent-defaults.ts` | zod schema 新增 `proactiveTriggerRatio` 验证 (0-1) |
| `src/cron/isolated-agent/run-executor.ts` | cron executor 对 CLI-provider 模型路由到 `runCliAgent` |
| `src/cron/isolated-agent/run-execution.runtime.ts` | 导出 `runCliAgent` 和 `isCliProvider` |
| `src/cron/isolated-agent/run.test-harness.ts` | 新增 `runCliAgentMock` 和 `isCliProviderMock` |

## 伪代码 (Pseudocode)

### 1. 主动式压缩 (Proactive Post-Run Compaction)

```javascript
// 在 runEmbeddedPiAgent 的成功运行后
async function proactiveCompaction(lastRunPromptUsage, ctxInfo) {
  // 前置条件检查
  if (aborted || timedOut) return          // 正在中断/超时，不压缩
  if (autoCompactionCount > 0) return       // 本轮已压缩过，不重复
  if (proactiveCompactionRatio <= 0) return  // 配置禁用

  // 计算 prompt 占比
  const promptTokens = derivePromptTokens(lastRunPromptUsage)
  const ratio = promptTokens / ctxInfo.tokens  // 例如 150000 / 200000 = 0.75

  // 超过阈值则触发压缩
  if (ratio <= proactiveCompactionRatio) return  // 默认 0.8

  log.info(`[proactive-compaction] ${promptTokens}/${ctxInfo.tokens} ` +
    `(${Math.round(ratio * 100)}%) > ${Math.round(proactiveCompactionRatio * 100)}% 阈值`)

  // 执行压缩
  await runOwnsCompactionBeforeHook("proactive")
  const result = await contextEngine.compact({
    sessionId, sessionKey, sessionFile,
    tokenBudget: ctxInfo.tokens,
    currentTokenCount: promptTokens,
    force: true,
    compactionTarget: "budget",
  })

  if (result.compacted) {
    // 压缩成功：运行 maintenance，清除旧 usage 元数据
    await runContextEngineMaintenance({ reason: "compaction" })
    agentMeta.usage = undefined      // 防止旧的 high-water mark 覆盖
    agentMeta.lastCallUsage = undefined
    autoCompactionCount += 1
  }

  await runOwnsCompactionAfterHook("proactive", result)
}
```

### 2. CLI-Provider 路由分发

```javascript
// attempt-execution.ts
function runAgentAttempt(params) {
  // 检查 provider 是否是 CLI provider (claude-cli/*, codex-cli/*)
  if (isCliProvider(params.providerOverride, params.cfg)) {
    // 路由到 CLI runner（通过子进程执行 claude -p）
    return runCliAgent({
      provider: params.providerOverride,
      model: params.modelOverride,
      prompt: effectivePrompt,
      abortSignal: params.opts.abortSignal,
      // ...其他参数
    })
  }

  // 非 CLI provider → 走嵌入式 runner
  return runEmbeddedPiAgent({ ... })
}

// pi-embedded-runner/run.ts -- 防御性检查
function runEmbeddedPiAgent(params) {
  if (isCliProvider(provider, params.config)) {
    // 拒绝 CLI refs 进入嵌入式 runner
    throw new FailoverError(
      `CLI-provider model ${provider}/${modelId} was routed to the embedded runner; ` +
      `caller must dispatch to runCliAgent.`,
      { reason: "model_not_found" }
    )
  }
  // ...正常执行
}
```

### 3. Abort 信号传播 (`checkAbortSignal`)

```javascript
function checkAbortSignal(signal) {
  if (!signal?.aborted) return  // 未中断，继续

  // 信号已触发 → 构造 AbortError 抛出
  const reason = signal.reason
  if (reason instanceof Error) throw reason

  const err = new Error("CLI runner aborted", { cause: reason })
  err.name = "AbortError"  // 必须设为 AbortError，downstream 用 name 识别
  throw err
}

// 在每次子进程 spawn 前调用
async function executeCliWithSession(sessionId, prompt, ...) {
  checkAbortSignal(params.abortSignal)  // 单一检查点
  // ...spawn subprocess
}

// /compact 期间 abort 也要传播
try {
  await contextEngine.compact(...)
} catch (compactErr) {
  if (compactErr.name === "AbortError") throw compactErr  // 不吞没
  // ...其他错误处理
}
```

### 4. 日志配置直接文件读取

```javascript
function resolveLoggingConfigPath(env) {
  // 轻量级路径解析（不导入完整 config 模块）
  if (env.OPENCLAW_CONFIG_PATH) return resolve(env.OPENCLAW_CONFIG_PATH)
  if (env.OPENCLAW_STATE_DIR) return join(resolve(env.OPENCLAW_STATE_DIR), "openclaw.json")
  return join(homedir(), ".openclaw", "openclaw.json")
}

function readLoggingConfig() {
  // 直接读 JSON 文件（bundle-safe，不依赖 createRequire）
  const configPath = resolveLoggingConfigPath()
  const raw = fs.readFileSync(configPath, "utf-8")
  const parsed = JSON.parse(raw)
  return parsed?.logging
}
```

## 数据流程图 (Data Flow Diagram)

### 主动式压缩触发流程

```
┌─────────────────────────────────────────────────────────┐
│              runEmbeddedPiAgent 主循环                     │
│                                                         │
│  API 调用 ──→ 模型推理 ──→ 工具调用 ──→ 输出生成           │
│                                                         │
│  成功完成 (payloads 非空，未中断/超时)                      │
│         │                                               │
│         ▼                                               │
│  ┌─────────────────────────────────┐                    │
│  │   主动压缩检查                    │                    │
│  │                                 │                    │
│  │   promptTokens = 160,000        │                    │
│  │   contextWindow = 200,000       │                    │
│  │   ratio = 0.80                  │                    │
│  │   threshold = 0.80 (default)    │                    │
│  │                                 │                    │
│  │   ratio > threshold? ──→ YES    │                    │
│  └────────────┬────────────────────┘                    │
│               │                                         │
│               ▼                                         │
│  ┌─────────────────────────────────┐                    │
│  │   contextEngine.compact()       │                    │
│  │                                 │                    │
│  │   force: true                   │                    │
│  │   compactionTarget: "budget"    │                    │
│  │   tokenBudget: 200,000          │                    │
│  │   currentTokenCount: 160,000    │                    │
│  └────────────┬────────────────────┘                    │
│               │                                         │
│         ┌─────┴─────┐                                   │
│         ▼           ▼                                   │
│    compacted    not compacted                            │
│         │           │                                   │
│         ▼           ▼                                   │
│  清除旧 usage   log.warn()                               │
│  maintenance                                            │
│  count += 1                                             │
│         │                                               │
│         ▼                                               │
│  返回结果（下一轮从压缩后的上下文开始）                       │
└─────────────────────────────────────────────────────────┘
```

### CLI-Provider 路由决策

```
                    用户消息到达
                         │
                         ▼
              ┌─────────────────────┐
              │ model fallback 选择  │
              │ provider = claude-cli│
              │ model = sonnet       │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ isCliProvider()?     │
              │                     │
              │ claude-cli ──→ YES  │
              │ codex-cli  ──→ YES  │
              │ anthropic  ──→ NO   │
              └─────┬─────┬─────────┘
                YES │     │ NO
                    ▼     ▼
         ┌──────────┐  ┌──────────────────┐
         │runCliAgent│  │runEmbeddedPiAgent│
         │           │  │                  │
         │ spawn     │  │ 防御性检查:       │
         │ claude -p │  │ if isCliProvider  │
         │ subprocess│  │   throw Failover │
         └──────────┘  └──────────────────┘
```

### Abort 信号传播路径

```
  用户发送 /stop
       │
       ▼
  abortSessionExecutions()
       │
       ▼
  signal.aborted = true
       │
       ├──→ 正在运行的子进程被 kill
       │
       ├──→ JS 编排层下一个 spawn 点:
       │      checkAbortSignal(signal)
       │            │
       │            ▼
       │      throw AbortError
       │            │
       │            ├──→ cli-runner.ts: 早期返回 (不进 failover)
       │            ├──→ execute.ts /compact: 不吞没 abort
       │            └──→ 上层 catch: 识别 err.name === "AbortError"
       │
       └──→ followup run (agent-runner-execution.ts)
              abortSignal 现已正确传递
              → followup 也能被中断
```

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/agents/pi-settings.ts` | 10-15 | `DEFAULT_PROACTIVE_COMPACTION_RATIO = 0.8` 默认值定义和 JSDoc |
| `src/agents/pi-settings.ts` | 52-65 | `resolveProactiveCompactionRatio`：从配置读取 [0,1] 范围的比例值 |
| `src/agents/pi-embedded-runner/run.ts` | 340-341 | 解析 `proactiveCompactionRatio`，在运行循环开始前读取 |
| `src/agents/pi-embedded-runner/run.ts` | 1507-1619 | 主动压缩完整实现：条件检查 → compact → maintenance → 清除旧 usage |
| `src/agents/pi-embedded-runner/run.ts` | 170-182 | 拒绝 CLI-provider refs 的防御性 FailoverError |
| `src/agents/command/attempt-execution.ts` | 342-374 | CLI-provider 模型分发到 `runCliAgent` |
| `src/agents/cli-runner.ts` | 153-161 | AbortError 早期返回，防止被 failover classifier 包装 |
| `src/agents/cli-runner/execute.ts` | 234-253 | `checkAbortSignal`：构造标准 AbortError |
| `src/agents/cli-runner/execute.ts` | 312-313 | `executeCliWithSession` 入口处调用 `checkAbortSignal` |
| `src/agents/cli-runner/execute.ts` | 1425-1431 | /compact 期间 AbortError 传播（不吞没） |
| `src/auto-reply/reply/agent-runner-execution.ts` | 789 | followup run 路径传递 `abortSignal` |
| `src/agents/workspace.ts` | 543-548 | BOOTSTRAP.md 缺失时跳过（不加入 missing 列表） |
| `src/logging/config.ts` | 17-32 | `resolveLoggingConfigPath`：轻量级路径解析（不导入完整 config 模块） |
| `src/logging/config.ts` | 45-55 | `readLoggingConfig`：`fs.readFileSync` 直接读 JSON（bundle-safe） |
| `src/config/types.agent-defaults.ts` | 356-362 | `proactiveTriggerRatio` 类型定义和 JSDoc |
| `src/config/zod-schema.agent-defaults.ts` | 116 | zod validation: `z.number().min(0).max(1).optional()` |
| `src/cron/isolated-agent/run-executor.ts` | 100-176 | cron executor CLI-provider 分发逻辑（if/else 分支） |
