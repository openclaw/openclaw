# Patch 03: Model-Aware Runner 适配、Bootstrap 压缩与图像预分析管道

## 为什么要改 (Why)

### 问题 1: embedded runner 不支持 CLI provider 后端

当用户配置 `claude-cli` 或 `codex-cli` 作为 provider 时，`runEmbeddedPiAgent` 直接调用 pi-agent 的内嵌 LLM API，无法路由到 CLI 后端。需要一个 model-aware 包装层，根据 provider 类型自动分发到 `runCliAgent`（CLI 后端）或 `runEmbeddedPiAgent`（API 后端），同时统一 agent event 回调映射。

### 问题 2: Bootstrap 上下文文件（MEMORY.md）无压缩机制

长期运行的 agent session 中，`MEMORY.md` 和 `memory/YYYY-MM-DD.md` 文件持续增长，占据大量 context window。每次 session 启动都会将完整文件内容注入 system prompt，导致 prompt tokens 膨胀。需要一个 LLM 驱动的压缩机制，在启动时将大文件总结为结构化摘要，同时保留关键标识符和近期信息。

### 问题 3: 主模型缺少视觉能力时无法理解图片

MiniMax M2.1、GLM 等模型不支持原生 vision 输入，当用户发送图片消息时直接丢失图像内容。需要一个图像预分析管道：先用配置的 `imageModel`（如 claude/gpt-4o）分析图片生成文字描述，再将描述注入 prompt 传给主模型。

### 问题 4: NO_REPLY token 在 BPE 分词下被拆分导致泄漏

部分 tokenizer 将 `NO_REPLY` 拆分为 `NO` + `_REPLY` 两个 streaming chunk。现有检测逻辑 `isSilentReplyPrefixText` 要求至少包含下划线才算前缀匹配，导致第一个 chunk `NO` 通过检测作为正常文本发送给用户，随后 `_REPLY` 被识别为尾部碎片也泄漏出去。需要更宽松的前缀检测（`couldBeSilentTokenStart`）和尾部碎片检测（`isSilentReplyTailFragmentText`）。

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `src/agents/model-aware-runner.ts` | 新增 `runModelAwareAgent`：根据 `isCliProvider` 分发到 `runCliAgent` 或 `runEmbeddedPiAgent`；统一 `onAssistantTurn`/`onThinkingTurn`/`onToolUseEvent`/`onToolResult` 回调映射到 `onPartialReply`/`onAgentEvent` |
| `src/agents/model-aware-runner.test.ts` | model-aware runner 分发逻辑和回调映射的测试 |
| `src/agents/model-selection.ts` | 新增 `isCliProvider()` 检测 CLI 后端（含 `claude-cli`/`codex-cli`/动态 cliBackends）；新增 `resolveNonCliModelRef()` 将 CLI provider 映射到真实 API provider |
| `src/agents/model-selection.test.ts` | CLI provider 检测和模型引用解析的测试 |
| `src/agents/bootstrap-compaction.ts` | 新增完整模块：`compactBootstrapFile` 单文件 LLM 压缩（含 SHA-256 内容哈希缓存、head+tail 截断策略、输出长度守卫）；`compactBootstrapFiles` 批量压缩（最大 3 文件、per-file + overall 超时）；`COMPACTION_SYSTEM_PROMPT` 结构化摘要模板 |
| `src/agents/bootstrap-compaction.test.ts` | 压缩管道的 601 行完整测试（缓存命中/失效、空输出、超时、max files 选择） |
| `src/agents/pi-embedded-runner/run/image-pre-analysis.ts` | 新增 `shouldUseImagePreAnalysis` 检测 imageModel 配置；`analyzeImagesWithImageModel` 并行分析所有图片，使用 `runWithImageModelFallback` 支持多 model fallback |
| `src/agents/pi-embedded-runner/run/image-pre-analysis.test.ts` | 预分析逻辑测试 |
| `src/agents/pi-embedded-runner/run/image-pre-analysis.behavior.test.ts` | 行为级别集成测试 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | 图像处理路径重构：检测 `shouldUseImagePreAnalysis` -> 先预分析 -> 主模型收到文字描述；fallback 到主模型 vision（如支持）；注册/注销 `registerLiveSessionTranscript` |
| `src/agents/pi-embedded-runner/live-session-registry.ts` | 新增进程级会话 transcript 注册表：`registerLiveSessionTranscript`（按 sessionKey/sessionId 注册 reader）和 `getLiveSessionTranscriptEntries`（查询活跃会话 entries） |
| `src/agents/pi-embedded-runner/types.ts` | `EmbeddedPiRunResult` 类型扩展 |
| `src/auto-reply/tokens.ts` | 新增 `couldBeSilentTokenStart()` 宽松前缀检测（不要求下划线）；新增 `isSilentReplyTailFragmentText()` 尾部碎片检测（以 `_` 开头的 token 尾部） |
| `src/auto-reply/tokens.test.ts` | 新 token 检测函数的测试 |
| `src/auto-reply/reply/normalize-reply.ts` | `normalizeReplyPayload` 增加 `isSilentReplyTailFragmentText` 检测，碎片化 silent token 也被过滤 |
| `src/auto-reply/reply/reply-utils.test.ts` | 回复规范化的新测试 |
| `src/infra/outbound/payloads.ts` | `normalizeReplyPayloadsForDelivery` 增加 `isSilentReplyTailFragmentText` 检测 |
| `src/infra/outbound/payloads.test.ts` | payloads 规范化的新测试 |
| `src/agents/tool-summaries.ts` | 新增 `buildToolSummaryMap`：从工具列表构建 `name -> description` 映射 |
| `src/agents/pi-tools.ts` | 支持 `allowReadOutsideWorkspace` 配置；当启用时使用 `createHostReadTool` 绕过 workspace 边界限制（附警告日志）|
| `src/agents/pi-tools.read.ts` | host read tool 实现 |
| `src/agents/pi-embedded-runner/compact.ts` | 压缩运行时微调 |
| `src/agents/bootstrap-budget.ts` | bootstrap 预算常量调整 |
| `src/agents/bootstrap-files.ts` | bootstrap 文件加载微调 |
| `src/agents/btw.ts` | btw (by the way) 推送逻辑调整 |
| `src/agents/command/session-store.ts` | CLI session store 新增字段 |
| `src/agents/pi-embedded-helpers.ts` | 嵌入式 helper 新增导出 |
| `src/agents/pi-embedded-helpers/bootstrap.ts` | bootstrap profile 加载扩展 |
| `src/agents/pi-embedded-helpers/errors.ts` | 新增错误分类辅助函数（billing error 检测） |
| `src/agents/pi-embedded-helpers/failover-matches.ts` | failover 匹配规则扩展 |
| `src/agents/pi-embedded-runner/run.ts` | run 入口微调 |
| `src/agents/skills/skill-contract.ts` | skill contract 类型扩展 |
| `src/agents/skills/workspace.ts` | workspace skill 辅助扩展 |
| `src/agents/system-prompt.ts` | system prompt 组装微调 |
| `src/agents/tool-fs-policy.ts` | `createToolFsPolicy` 增加 `allowReadOutsideWorkspace` |
| `src/agents/tools/session-status-tool.ts` | session status 工具输出扩展 |
| `src/auto-reply/reply/agent-runner-execution.ts` | agent runner 执行流程微调 |
| `src/cron/isolated-agent/run.ts` | 从专用 `run.runtime.ts` barrel 改为直接 import 各模块（消除中间层） |
| `src/agents/acp-spawn-parent-stream.ts` | ACP spawn 流微调 |
| `src/agents/agent-command.ts` | agent command 小修正 |
| `src/agents/models-config.providers.openai-codex.test.ts` | OpenAI Codex provider 配置测试 |
| `src/agents/openclaw-tools.web-runtime.test.ts` | web runtime 工具测试 |
| `src/agents/pi-embedded-helpers.bootstrap-profiles.test.ts` | bootstrap profile 测试 |
| `src/agents/pi-embedded-helpers.isbillingerrormessage.test.ts` | billing error 检测测试 |
| `src/agents/pi-embedded-runner/extra-params.openai.test.ts` | OpenAI 额外参数测试 |
| `src/agents/pi-embedded-runner/extra-params.xai-tool-payload.test.ts` | xAI 工具 payload 测试 |
| `src/agents/bash-tools.exec.pty-fallback-failure.test.ts` | bash 工具 PTY fallback 测试 |
| `src/agents/bash-tools.process.supervisor.test.ts` | bash 进程 supervisor 测试 |

## 伪代码 (Pseudocode)

### 1. Model-Aware Runner 分发 (runModelAwareAgent)

```javascript
// src/agents/model-aware-runner.ts:32
async function runModelAwareAgent(params) {
  const provider = (params.provider ?? DEFAULT_PROVIDER).trim()

  // 非 CLI provider -> 直接走 embedded runner
  if (!isCliProvider(provider, params.config)) {
    return runEmbeddedPiAgent(params)
  }

  // CLI provider -> 路由到 CLI runner，映射回调
  const visibleTextAccumulator = createAcpVisibleTextAccumulator()
  return runCliAgent({
    ...params,
    provider,
    onAssistantTurn: (text) => {
      const update = visibleTextAccumulator.consume(text)
      if (update?.delta) {
        params.onPartialReply?.({ text: update.delta })
      }
      params.onAgentEvent?.({ stream: "assistant", data: { text, delta: update.delta } })
    },
    onThinkingTurn: (payload) => {
      params.onReasoningStream?.({ text: payload.text })
      params.onAgentEvent?.({ stream: "thinking", data: payload })
    },
    onToolUseEvent: (payload) => {
      params.onAgentEvent?.({ stream: "tool", data: { phase: "start", name: payload.name } })
    },
    onToolResult: (payload) => {
      params.onToolResult?.({ text: payload.text })
      params.onAgentEvent?.({ stream: "tool", data: { phase: "result", result: payload.text } })
    },
  })
}
```

### 2. Bootstrap 文件 LLM 压缩 (compactBootstrapFile)

```javascript
// src/agents/bootstrap-compaction.ts:153
async function compactBootstrapFile({ content, filePath, config, llmFn, modelRef, signal }) {
  const charsBefore = content.length

  // 输入截断: head 30% + tail 70% (最新内容在文件底部)
  let inputContent = content
  if (content.length > COMPACTION_MAX_INPUT_CHARS) { // 10,000 chars
    const headChars = Math.floor(10000 * 0.3)
    const tailChars = 10000 - headChars
    inputContent = content.slice(0, headChars)
      + "\n\n[... middle content omitted ...]\n\n"
      + content.slice(-tailChars)
  }

  // 内容哈希缓存查找 (key = version + modelRef + fullContent)
  const contentHash = sha256(`v${CACHE_VERSION}:${modelRef}:${content}`).slice(0, 16)
  const cached = compactionCache.get(filePath)
  if (cached?.hash === contentHash) {
    return { compacted: cached.compacted, result: { success: true, ... } }
  }

  // LLM 压缩调用
  const compacted = await llmFn(inputContent, signal)

  // 输出守卫: 空输出或未缩短 -> 回退到原始内容
  if (!compacted.trim()) return { compacted: content, fallbackReason: "empty output" }
  if (compacted.length >= charsBefore) return { compacted: content, fallbackReason: "not shorter" }

  // 缓存 (LRU, 最大 100 条)
  cacheSet(filePath, { hash: contentHash, compacted })
  return { compacted, result: { success: true, charsBefore, charsAfter: compacted.length } }
}
```

### 3. 图像预分析管道 (analyzeImagesWithImageModel)

```javascript
// src/agents/pi-embedded-runner/run/image-pre-analysis.ts:44
async function analyzeImagesWithImageModel({ images, config, agentDir, userPrompt }) {
  // 构建分析 prompt (如有用户问题则嵌入上下文)
  const analysisPrompt = userPrompt
    ? `User's question: "${userPrompt}"\nDescribe the image to help answer.`
    : DEFAULT_IMAGE_ANALYSIS_PROMPT

  // 并行分析所有图片
  const tasks = images.filter(img => img.type === "image")
  const settled = await Promise.allSettled(
    tasks.map(async (task, i) => {
      return runWithImageModelFallback({
        cfg: config,
        run: async (provider, modelId) => {
          // 发现模型、验证 vision 支持、获取 API key
          const model = modelRegistry.find(provider, modelId)
          if (!model.input?.includes("image")) throw new Error("not vision model")
          const apiKey = await getApiKeyForModel({ model, cfg: config, agentDir })

          // 调用 complete() API 分析图片
          const message = await complete(model, {
            messages: [{ role: "user", content: [
              { type: "text", text: analysisPrompt },
              { type: "image", data: task.data, mimeType: task.mimeType },
            ]}]
          }, { apiKey, maxTokens: 1024 })

          return { text: extractTextFromResponse(message), provider, model: modelId }
        }
      })
    })
  )

  // 汇总分析结果，构建注入 prompt 的文本
  const analyses = settled.filter(成功).map(r =>
    `[Image ${r.index + 1} Analysis]\n${r.text}`)
  return {
    analysisText: `\n---\nImage analysis by ${provider}/${model}:\n\n${analyses.join("\n\n")}\n---\n`,
    imageCount: tasks.length,
    successfulImageCount: analyses.length,
  }
}
```

### 4. attempt.ts 中的图像处理分支

```javascript
// src/agents/pi-embedded-runner/run/attempt.ts:1757
if (imageResult.images.length > 0) {
  const mainModelSupportsImages = modelSupportsImages(params.model)
  const usePreAnalysis = shouldUseImagePreAnalysis({ config: params.config })

  if (usePreAnalysis) {
    // 路径 A: 用 imageModel 预分析
    try {
      const preAnalysis = await analyzeImagesWithImageModel({
        images: imageResult.images,
        config: params.config,
        agentDir: params.agentDir,
        userPrompt: effectivePrompt,
      })
      if (preAnalysis.successfulImageCount > 0) {
        // 文本描述注入 prompt，不传图片给主模型
        await activeSession.prompt(effectivePrompt + preAnalysis.analysisText)
      } else if (mainModelSupportsImages) {
        // 预分析全部失败，fallback 到主模型 vision
        await activeSession.prompt(effectivePrompt, { images })
      } else {
        // 无 vision 能力，忽略图片
        await activeSession.prompt(effectivePrompt)
      }
    } catch {
      // 预分析异常，同样 fallback
      if (mainModelSupportsImages) {
        await activeSession.prompt(effectivePrompt, { images })
      } else {
        await activeSession.prompt(effectivePrompt)
      }
    }
  } else if (mainModelSupportsImages) {
    // 路径 B: 无 imageModel 配置，主模型直接处理图片
    await activeSession.prompt(effectivePrompt, { images })
  } else {
    // 路径 C: 两者都不支持，忽略图片
    await activeSession.prompt(effectivePrompt)
  }
}
```

### 5. BPE 分词碎片检测

```javascript
// src/auto-reply/tokens.ts:97
function couldBeSilentTokenStart(text, token = "NO_REPLY") {
  const trimmed = text.trimStart()
  // 必须全大写 + 下划线（拒绝 "No"、"no"）
  if (/[^A-Z_]/.test(trimmed)) return false
  // 必须是严格前缀（短于完整 token）
  return trimmed.length < token.length && token.startsWith(trimmed)
  // "NO" -> true (是 "NO_REPLY" 的前缀)
  // "NO_" -> true (isSilentReplyPrefixText 也能捕获，但此函数更宽松)
}

// src/auto-reply/tokens.ts:116
function isSilentReplyTailFragmentText(text, token = "NO_REPLY") {
  const trimmed = text.trim().toUpperCase()
  // 必须以 "_" 开头（这是 BPE 拆分的第二个 chunk 特征）
  if (!trimmed.startsWith("_")) return false
  // 必须短于完整 token
  if (trimmed.length >= token.length) return false
  // 必须全大写 + 下划线
  if (/[^A-Z_]/.test(trimmed)) return false
  // 必须是 token 的尾部
  return token.toUpperCase().endsWith(trimmed)
  // "_REPLY" -> true (是 "NO_REPLY" 的尾部)
}
```

## 数据流程图 (Data Flow Diagram)

### Model-Aware Runner 分发流程

```
┌─────────────────────┐
│  runModelAwareAgent  │
│  (params)            │
└──────────┬──────────┘
           │
     isCliProvider(provider)?
           │
    ┌──────┴──────┐
    │ Yes         │ No
    ▼             ▼
┌──────────┐  ┌──────────────────┐
│ runCli-  │  │ runEmbeddedPi-   │
│ Agent()  │  │ Agent()          │
│          │  │ (直接 API 调用)   │
│ 回调映射: │  └──────────────────┘
│ onAssistantTurn -> onPartialReply + onAgentEvent(assistant)
│ onThinkingTurn  -> onReasoningStream + onAgentEvent(thinking)
│ onToolUseEvent  -> onAgentEvent(tool/start)
│ onToolResult    -> onToolResult + onAgentEvent(tool/result)
└──────────┘
```

### Bootstrap 压缩管道

```
┌────────────────────────────────────────────────────┐
│            Agent Session Bootstrap                  │
│                                                    │
│  contextFiles = [                                  │
│    { path: "MEMORY.md", content: "..." (8000 chars)│
│    { path: "memory/2026-04-01.md", content: "..." }│
│    { path: "CLAUDE.md", content: "..." }           │
│  ]                                                 │
└──────────────────────┬─────────────────────────────┘
                       │
                       ▼
         ┌─────────────────────────┐
         │  compactBootstrapFiles  │
         │                         │
         │  1. 筛选 compactable    │
         │     (MEMORY.md,         │
         │      memory/YYYY-MM.md) │
         │  2. 按大小降序排列       │
         │  3. 取 top 3            │
         └────────────┬────────────┘
                      │
           ┌──────────┼──────────┐
           ▼          ▼          ▼
    ┌────────────┐ ┌──────┐ ┌──────┐
    │ MEMORY.md  │ │ day1 │ │ day2 │
    │ (8000ch)   │ │      │ │      │
    └─────┬──────┘ └──┬───┘ └──┬───┘
          │           │        │
          ▼           ▼        ▼
    ┌─────────────────────────────────┐
    │  compactBootstrapFile (per file) │
    │                                 │
    │  1. 截断: head 30% + tail 70%   │
    │  2. SHA-256 缓存查找            │
    │     命中 -> 直接返回            │
    │     未中 -> LLM 压缩            │
    │  3. 输出守卫:                    │
    │     空输出 -> fallback 原文      │
    │     未缩短 -> fallback 原文      │
    │  4. 缓存更新 (LRU, max 100)     │
    └─────────────────────────────────┘
          │
          ▼
    ┌─────────────────────────────────┐
    │  压缩后 system prompt           │
    │                                 │
    │  MEMORY.md: 8000 -> 3200 chars  │
    │  day1.md:   2000 -> 800 chars   │
    │  CLAUDE.md: 保持不变 (不压缩)    │
    └─────────────────────────────────┘
```

### 图像预分析管道

```
┌──────────────┐    images[]     ┌──────────────────────────┐
│  User Message │───────────────>│  attempt.ts              │
│  + 3 images   │                │  shouldUseImagePreAnalysis?│
└──────────────┘                └──────────┬───────────────┘
                                           │
                              ┌────────────┴────────────┐
                              │ Yes (imageModel配置)     │ No
                              ▼                         ▼
                ┌─────────────────────────┐   ┌─────────────────────┐
                │ analyzeImagesWithImage  │   │ mainModel 有 vision? │
                │ Model()                 │   │  Yes -> prompt+images│
                │                         │   │  No  -> prompt only  │
                │ 并行:                    │   └─────────────────────┘
                │  img1 -> imageModel.run │
                │  img2 -> imageModel.run │
                │  img3 -> imageModel.run │
                │  (含 fallback 链)       │
                └────────────┬────────────┘
                             │
                    成功数 > 0?
                    ┌────────┴────────┐
                    │ Yes             │ No
                    ▼                 ▼
    ┌──────────────────────┐  ┌──────────────────────┐
    │ prompt + analysisText│  │ mainModel 有 vision?  │
    │ (不传图片给主模型)    │  │  Yes -> prompt+images │
    │                      │  │  No  -> prompt only   │
    │ "User question..."   │  └──────────────────────┘
    │ ---                  │
    │ [Image 1 Analysis]   │
    │ A dashboard showing..│
    │ [Image 2 Analysis]   │
    │ Code snippet with... │
    │ ---                  │
    └──────────────────────┘
```

### NO_REPLY BPE 碎片检测流程

```
   LLM Streaming Output: "NO" -> "_REPLY"
                          ~~~     ~~~~~~~
                          chunk1  chunk2

   ┌──────────────────────────────────────────────────┐
   │  chunk1: "NO"                                    │
   │                                                  │
   │  isSilentReplyText("NO")    -> false (太短)      │
   │  isSilentReplyPrefixText("NO") -> false (无 _)   │
   │  couldBeSilentTokenStart("NO") -> true  ← 新增!  │
   │                                                  │
   │  结果: 暂缓输出，等待更多 chunk                    │
   └──────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────┐
   │  chunk2: "_REPLY"                                │
   │                                                  │
   │  拼接: "NO_REPLY" -> isSilentReplyText -> true   │
   │  结果: 整条消息被识别为 NO_REPLY，静默处理         │
   └──────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────┐
   │  兜底: 如果 chunk2 独立到达 normalizeReplyPayload │
   │                                                  │
   │  isSilentReplyTailFragmentText("_REPLY") -> true │
   │  结果: 碎片也被过滤掉，不会泄漏给用户              │
   └──────────────────────────────────────────────────┘
```

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/agents/model-aware-runner.ts` | 9 | `function resolveDecisionLikeSystemPrompt()` - disableTools 时注入系统提示 |
| `src/agents/model-aware-runner.ts` | 32 | `export async function runModelAwareAgent()` - 分发入口 |
| `src/agents/model-selection.ts` | 113 | `export function isCliProvider()` - CLI 后端检测（含动态 cliBackends） |
| `src/agents/model-selection.ts` | 307 | `export function buildModelAliasIndex()` - 模型别名索引构建 |
| `src/agents/model-selection.ts` | 338 | `export function resolveModelRefFromString()` - 字符串到 ModelRef 解析 |
| `src/agents/bootstrap-compaction.ts` | 110 | `export function resolveCompactionConfig()` - 从 cfg 解析压缩配置 |
| `src/agents/bootstrap-compaction.ts` | 126 | `export function isCompactableFile()` - MEMORY.md / memory/*.md 识别 |
| `src/agents/bootstrap-compaction.ts` | 153 | `export async function compactBootstrapFile()` - 单文件 LLM 压缩 |
| `src/agents/bootstrap-compaction.ts` | 265 | `export async function compactBootstrapFiles()` - 批量压缩入口 |
| `src/agents/pi-embedded-runner/run/image-pre-analysis.ts` | 31 | `export function shouldUseImagePreAnalysis()` - imageModel 配置检测 |
| `src/agents/pi-embedded-runner/run/image-pre-analysis.ts` | 44 | `export async function analyzeImagesWithImageModel()` - 并行图像分析 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | 774-780 | live session transcript 注册和 cleanup |
| `src/agents/pi-embedded-runner/run/attempt.ts` | 1757-1820 | 图像预分析三路分支处理 |
| `src/agents/pi-embedded-runner/live-session-registry.ts` | 29 | `export function registerLiveSessionTranscript()` - 注册活跃会话 |
| `src/agents/pi-embedded-runner/live-session-registry.ts` | 66 | `export function getLiveSessionTranscriptEntries()` - 查询会话 entries |
| `src/auto-reply/tokens.ts` | 97 | `export function couldBeSilentTokenStart()` - BPE 前缀宽松检测 |
| `src/auto-reply/tokens.ts` | 116 | `export function isSilentReplyTailFragmentText()` - 尾部碎片检测 |
| `src/auto-reply/reply/normalize-reply.ts` | 52-58 | `normalizeReplyPayload` 增加尾部碎片过滤 |
| `src/infra/outbound/payloads.ts` | 84-89 | `normalizeReplyPayloadsForDelivery` 增加尾部碎片过滤 |
| `src/agents/tool-summaries.ts` | 3 | `export function buildToolSummaryMap()` - 工具摘要映射 |
| `src/agents/pi-tools.ts` | 397-399 | `createToolFsPolicy` 增加 `allowReadOutsideWorkspace` |
| `src/agents/pi-tools.ts` | 442-458 | `allowReadOutsideWorkspace` 启用时使用 `createHostReadTool` |
| `src/cron/isolated-agent/run.ts` | 1-37 | 直接 import 替代 `run.runtime.ts` barrel（消除中间层） |
