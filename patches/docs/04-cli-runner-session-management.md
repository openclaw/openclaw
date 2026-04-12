# Patch 04: CLI Runner 基础设施 — 上下文溢出保护、会话管理、多后端支持

## 为什么要改 (Why)

### 问题 1: CLI 后端上下文窗口溢出无恢复机制

当 Claude CLI / Codex 等后端的上下文窗口被长 system prompt 或多轮对话撑满时，子进程直接报错退出。没有任何层级的自动恢复，用户看到的是不可理解的 `context_overflow` 错误。

### 问题 2: 多 CLI 后端缺乏统一抽象

系统仅支持 Claude CLI 一个后端，添加 Google / OpenAI CLI 后端需要到处散布 provider 特有逻辑。缺少统一的后端配置解析、模型别名映射、session 管理和 watchdog 超时策略。

### 问题 3: CLI 会话状态未持久化

每次对话都是全新会话，无法复用之前的 `session_id`。Claude CLI 的 `--resume` 功能完全闲置，导致上下文缓存命中率为零，每轮都重新注入全量 system prompt。

### 问题 4: 流式输出解析不统一

不同 CLI 后端输出格式各异（JSON / JSONL / streaming events）。缺少统一的解析层来提取文本、session ID、usage 统计、tool-use 事件，导致 streaming card、typing indicator、tool 结果展示等功能无法对接。

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `src/agents/cli-runner.ts` | 顶层入口：`runCliAgent()` 编排 prepare → execute → failover |
| `src/agents/cli-runner/execute.ts` | 3 层溢出保护核心：bootstrap compaction → session prompt file → chunk splitting |
| `src/agents/cli-runner/prepare.ts` | 运行上下文准备：后端解析、API key、MCP 配置、prompt 文件分块写入 |
| `src/agents/cli-runner/helpers.ts` | 工具函数：system prompt 构建、CLI 参数组装、JSON/JSONL 解析、图片处理 |
| `src/agents/cli-runner/types.ts` | `RunCliAgentParams` 和 `PreparedCliRunContext` 类型定义 |
| `src/agents/cli-runner/bundle-mcp.ts` | MCP 服务器配置合并与临时文件注入 |
| `src/agents/cli-runner/reliability.ts` | Watchdog 超时策略：fresh/resume 两档、ratio/min/max 计算 |
| `src/agents/cli-backends.ts` | 多后端注册：Claude/Codex/Google/OpenAI 别名映射与配置归一化 |
| `src/agents/cli-output.ts` | 流式输出解析器：JSONL streaming parser、tool-use 去重、delta 提取 |
| `src/agents/cli-session.ts` | 会话绑定与复用：hash 比对、`resolveCliSessionReuse()` |
| `src/agents/cli-credentials.ts` | 凭证管理：Claude OAuth/token、Codex token、缓存读取 |
| `src/agents/cli-auth-epoch.ts` | 认证 epoch：SHA-256 指纹聚合，凭证变更时强制 session 轮转 |
| `src/auto-reply/reply/agent-runner-execution.ts` | streaming 回调注入，whitespace delta 直通 |
| `src/auto-reply/status.ts` | CLI prompt load 状态展示，session prompt file 验证状态 |
| `extensions/anthropic/cli-backend.ts` | Anthropic CLI 后端配置：`--bare`、`--resume`、permission mode |
| `extensions/anthropic/cli-migration.ts` | 旧版 claude-cli 配置迁移到新后端结构 |
| `extensions/anthropic/cli-shared.ts` | Claude CLI 共享工具：provider 判断、model alias |
| `extensions/google/cli-backend.ts` | Google CLI 后端注册 |
| `extensions/openai/cli-backend.ts` | OpenAI CLI 后端注册 |
| `src/plugins/cli-backends.runtime.ts` | 插件后端运行时解析入口 |
| `src/process/supervisor/supervisor.ts` | 进程监管器：scope key 绑定、session cancel |
| `src/config/sessions/disk-budget.ts` | session 磁盘预算：CLI prompt 文件纳入清理策略 |
| `src/gateway/mcp-http.schema.ts` | MCP loopback server schema 扩展 |
| `extensions/feishu/src/reply-dispatcher.ts` | Feishu 回复分发器适配 CLI streaming |
| `extensions/feishu/src/streaming-card.ts` | Feishu streaming card 适配新 streaming 事件 |

## 伪代码 (Pseudocode)

### 1. 三层上下文溢出保护 (`executeWithOverflowProtection`)

```javascript
async function executeWithOverflowProtection(context, cliSessionId) {
  let compactionsThisRun = 0;
  let latestPromptChunks = [];

  // 主循环：溢出 → 恢复 → 重试
  while (true) {
    try {
      // 第1层：将 system prompt 写入 session prompt file
      // Claude CLI 通过 Read tool 读取该文件（而非 --system-prompt 注入）
      const promptFile = await writeClaudeSystemPromptFile({
        content: systemPrompt,
        maxCharsPerChunk: 12_000,  // 单 chunk 上限
        minTailChunkChars: 1_000,  // 尾部小于此值合并到上一个 chunk
      });
      latestPromptChunks = promptFile.chunks;

      // 构建 loader prompt：指示 CLI 先读取 prompt file
      const loaderPrompt = buildClaudeSystemPromptLoaderPrompt(promptFile);

      // 执行 CLI 子进程
      const result = await executePreparedCliRun(context, {
        prompt: loaderPrompt,
        sessionId: cliSessionId,
        onToolResult: (payload) => {
          // 验证 Read tool 是否完整读取了 prompt file
          if (isExpectedPromptFileRead(payload)) {
            verifyReadCompleteness(payload);
          }
        },
      });

      return result;

    } catch (error) {
      if (!isContextOverflowError(error)) throw error;

      // 第2层：bootstrap compaction（压缩 context files）
      if (compactionsThisRun < maxCompactions) {
        compactionsThisRun++;
        systemPrompt = await compactBootstrapFiles(systemPrompt);
        continue;  // 重试
      }

      // 第3层：降级 profile（从 full → minimal → bare）
      if (canDowngradeProfile(activeProfile)) {
        activeProfile = downgradeProfile(activeProfile);
        systemPrompt = rebuildSystemPrompt(activeProfile);
        continue;
      }

      throw new FailoverError("context_overflow_unrecoverable");
    }
  }
}
```

### 2. CLI 后端配置解析 (`resolveCliBackendConfig`)

```javascript
function resolveCliBackendConfig(params) {
  const { provider, config, modelId } = params;

  // 1. 检查用户显式配置的后端
  const configured = config.cliBackends?.[provider];
  if (configured) {
    return { id: provider, config: configured, bundleMcp: false };
  }

  // 2. Claude 系列：映射 model alias → 标准 backend
  if (isClaudeCliProvider(provider)) {
    const alias = CLAUDE_MODEL_ALIASES[modelId.toLowerCase()];
    // alias: "opus" | "sonnet" | "haiku"
    return buildAnthropicCliBackend({
      model: alias ?? modelId,
      permissionMode: "--dangerously-skip-permissions",
      resumeArgs: ["--resume", "--session-id", "{sessionId}"],
    });
  }

  // 3. 插件注册的后端（Google, OpenAI 等）
  const pluginBackends = resolveRuntimeCliBackends();
  const match = pluginBackends.find(b => b.id === provider);
  if (match) return match;

  // 4. Codex 默认后端
  return DEFAULT_CODEX_BACKEND;
}
```

### 3. 流式 JSONL 解析 (`createCliJsonlStreamingParser`)

```javascript
function createCliJsonlStreamingParser(backend, callbacks) {
  let buffer = "";
  const seenToolUseIds = new Set();  // tool-use 去重

  return {
    feed(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();  // 保留不完整的最后一行

      for (const line of lines) {
        const parsed = JSON.parse(line);
        const type = parsed.type ?? "";

        // 流式文本 delta
        if (type === "assistant" || type === "content_block_delta") {
          const delta = extractTextDelta(parsed);
          if (delta) callbacks.onAssistantTurn(delta);
        }

        // thinking delta
        if (type === "thinking") {
          callbacks.onThinkingTurn({
            text: parsed.thinking ?? "",
            delta: parsed.delta ?? "",
          });
        }

        // tool-use 开始（去重同一个 toolUseId）
        if (type === "tool_use" && !seenToolUseIds.has(parsed.id)) {
          seenToolUseIds.add(parsed.id);
          callbacks.onToolUseEvent({
            name: parsed.name,
            toolUseId: parsed.id,
            input: parsed.input,
          });
        }

        // tool 结果
        if (type === "tool_result") {
          callbacks.onToolResult({
            toolUseId: parsed.tool_use_id,
            text: parsed.output,
            isError: parsed.is_error,
            // EOF → line-count 探测字段
            startLine: parsed.start_line,
            numLines: parsed.num_lines,
            totalLines: parsed.total_lines,
          });
        }

        // session_id / usage
        if (parsed.session_id) {
          callbacks.onSessionId(parsed.session_id);
        }
        if (parsed.usage) {
          callbacks.onUsage(parsed.usage);
        }
      }
    },
    flush() { /* 处理 buffer 中残留内容 */ },
  };
}
```

### 4. 认证 Epoch 管理 (`resolveCliAuthEpoch`)

```javascript
async function resolveCliAuthEpoch(params) {
  // 聚合所有活跃凭证的指纹
  const parts = [];

  // Claude CLI 凭证（OAuth 或 token）
  const claudeCreds = await readClaudeCliCredentialsCached();
  for (const cred of claudeCreds) {
    parts.push(hashCliAuthEpochPart(encodeClaudeCredential(cred)));
  }

  // Codex CLI 凭证
  const codexCreds = await readCodexCliCredentialsCached();
  for (const cred of codexCreds) {
    parts.push(hashCliAuthEpochPart(encodeCodexCredential(cred)));
  }

  // Auth profile store
  const store = await loadAuthProfileStoreForRuntime();
  parts.push(hashCliAuthEpochPart(encodeUnknown(store.active)));

  // 所有 part 排序后取 SHA-256 → 最终 epoch
  parts.sort();
  return crypto.createHash("sha256")
    .update(parts.join(":"))
    .digest("hex");
}
// 当 epoch 变化时，强制所有 CLI session 轮转（不复用旧 session_id）
```

## 数据流程图 (Data Flow Diagram)

### CLI Runner 整体执行流

```
┌──────────────────────────────────────────────────────────────────────┐
│                        runCliAgent()                                 │
│  src/agents/cli-runner.ts:12                                        │
└─────────────────────┬────────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│               prepareCliRunContext()                                  │
│  src/agents/cli-runner/prepare.ts                                    │
│                                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐          │
│  │ resolveBack │  │ resolveAuth  │  │ buildSystemPrompt  │          │
│  │ endConfig() │→ │ Epoch()      │→ │ + contextFiles     │          │
│  └─────────────┘  └──────────────┘  └────────┬───────────┘          │
│                                               │                      │
│  ┌──────────────────┐  ┌─────────────────┐    │                      │
│  │ prepareBundleMcp │  │ resolveSession  │    │                      │
│  │ Config()         │  │ Reuse()         │◄───┘                      │
│  └──────────────────┘  └─────────────────┘                           │
└─────────────────────┬────────────────────────────────────────────────┘
                      │ PreparedCliRunContext
                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│           executeWithOverflowProtection()                            │
│  src/agents/cli-runner/execute.ts:266                                │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │  Layer 1: Session Prompt File                           │         │
│  │  writeClaudeSystemPromptFile() → 分 chunk 写入          │         │
│  │  buildClaudeSystemPromptLoaderPrompt() → loader 提示    │         │
│  │  Read tool 回调验证 → EOF/行号探测                      │         │
│  └───────────────────┬─────────────────────────────────────┘         │
│                      ▼                                               │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │  Layer 2: Bootstrap Compaction                          │         │
│  │  溢出? → compactBootstrapFiles() → 重试                 │         │
│  └───────────────────┬─────────────────────────────────────┘         │
│                      ▼                                               │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │  Layer 3: Profile Downgrade                             │         │
│  │  仍溢出? → full→minimal→bare → 重建 prompt → 重试       │         │
│  └─────────────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────────────┘
```

### 多 CLI 后端解析流

```
┌──────────────┐
│ Provider ID  │  e.g. "claude-cli", "codex", "google", "openai"
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│          resolveCliBackendConfig()                │
│  src/agents/cli-backends.ts:50+                  │
│                                                  │
│  1. config.cliBackends[provider]? ──→ 用户配置   │
│  2. isClaudeProvider? ──→ Anthropic 后端工厂     │
│  3. pluginBackends.find()? ──→ 插件注册后端      │
│  4. DEFAULT_CODEX_BACKEND ──→ 兜底               │
└──────┬───────────────────────────────────────────┘
       │ ResolvedCliBackend { id, config, bundleMcp }
       ▼
┌──────────────────────────────────────────────────┐
│         CLI Backend Config                       │
│                                                  │
│  command: "claude" / "codex" / "gemini" / ...    │
│  args: ["--json", "--model", ...]                │
│  resumeArgs: ["--resume", "--session-id", ...]   │
│  sessionMode: "always" | "existing" | "none"     │
│  modelAliases: { "opus": "opus", ... }           │
│  reliability.watchdog: { fresh, resume }         │
└──────────────────────────────────────────────────┘
```

### 流式输出解析流

```
CLI 子进程 stdout
       │
       │  JSONL stream (一行一个 JSON event)
       ▼
┌──────────────────────────────────────────────────┐
│  createCliJsonlStreamingParser()                 │
│  src/agents/cli-output.ts                        │
│                                                  │
│  buffer += chunk                                 │
│  split("\n") → 逐行解析                          │
│                                                  │
│  ┌───────────┐  ┌───────────┐  ┌──────────────┐ │
│  │ assistant │  │ thinking  │  │  tool_use    │ │
│  │ delta     │  │ delta     │  │ (去重 ID)    │ │
│  └─────┬─────┘  └─────┬─────┘  └──────┬───────┘ │
│        │              │               │          │
│        ▼              ▼               ▼          │
│  onAssistant   onThinking      onToolUseEvent    │
│  Turn()        Turn()          onToolResult()    │
└──────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  Streaming Card / Typing Indicator / Reply       │
│  Feishu / Telegram / Web UI                      │
└──────────────────────────────────────────────────┘
```

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/agents/cli-runner.ts` | 12-60 | `runCliAgent()` 入口：prepare → execute → failover 编排 |
| `src/agents/cli-runner/execute.ts` | 118-132 | `CliSessionBindingResult` 类型：sessionId + prompt file hash |
| `src/agents/cli-runner/execute.ts` | 134-147 | `CliPromptLoadResult` 类型：loader mode + verified read 状态 |
| `src/agents/cli-runner/execute.ts` | 243-257 | `checkAbortSignal()`: 每次子进程 spawn 前的 abort 检查点 |
| `src/agents/cli-runner/execute.ts` | 266-328 | `executeWithOverflowProtection()`: 3 层保护主循环 |
| `src/agents/cli-runner/execute.ts` | 332-344 | `executeCliWithSession()`: abort signal → session resolve → resume 判定 |
| `src/agents/cli-runner/execute.ts` | 391-419 | Layer 1: 写入 session prompt file + semantic loader 路径 |
| `src/agents/cli-runner/prepare.ts` | 63-72 | 依赖注入 `prepareDeps` 测试接缝 |
| `src/agents/cli-runner/prepare.ts` | 101-164 | `resolveClaudeBareManagedEnv()`: `--bare` 模式下自动注入 API key |
| `src/agents/cli-runner/prepare.ts` | 170-176 | Chunk 常量：`MAX_CHARS=12000`, `MIN_TAIL_CHARS=1000` |
| `src/agents/cli-runner/helpers.ts` | 39-44 | `CLI_RUN_QUEUE`: 基于 `KeyedAsyncQueue` 的并发序列化 |
| `src/agents/cli-runner/helpers.ts` | 134-165 | `parseCliJson()` / `parseCliJsonl()`: 单 JSON / JSONL 解析 |
| `src/agents/cli-runner/helpers.ts` | 288-335 | `resolvePromptInput()`: arg vs stdin 路由 + `maxPromptArgChars` 阈值 |
| `src/agents/cli-runner/helpers.ts` | 384-459 | `buildCliArgs()`: 模型、session、system prompt、图片参数组装 |
| `src/agents/cli-runner/bundle-mcp.ts` | 77-130 | `prepareCliBundleMcpConfig()`: 合并 existing + bundle + additional MCP 配置 |
| `src/agents/cli-runner/reliability.ts` | 62-78 | `resolveCliNoOutputTimeoutMs()`: watchdog 超时计算 |
| `src/agents/cli-runner/reliability.ts` | 80-88 | `buildCliSupervisorScopeKey()`: 进程监管器 scope key |
| `src/agents/cli-backends.ts` | 36-53 | `CLAUDE_MODEL_ALIASES`: opus/sonnet/haiku 全版本映射表 |
| `src/agents/cli-backends.ts` | 55-70 | `DEFAULT_CODEX_BACKEND`: Codex 默认参数 |
| `src/agents/cli-output.ts` | 13-46 | `CliOutput` / `CliStreamingDelta` / `CliToolUsePayload` 类型定义 |
| `src/agents/cli-output.ts` | 48-60 | `extractJsonObjectCandidates()`: 从混合输出中提取 JSON 对象 |
| `src/agents/cli-session.ts` | 1-206 | `hashCliSessionText()` + `resolveCliSessionReuse()`: session 复用判定 |
| `src/agents/cli-credentials.ts` | 1-742 | Claude/Codex 凭证读取、OAuth token 解析、缓存管理 |
| `src/agents/cli-auth-epoch.ts` | 1-165 | `resolveCliAuthEpoch()`: 凭证指纹聚合 → epoch hash → session 轮转触发 |
| `src/auto-reply/reply/agent-runner-execution.ts` | 639-647 | whitespace delta 直通：跳过 `sanitizeUserFacingText` trim |
