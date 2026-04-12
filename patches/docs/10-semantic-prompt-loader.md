# Patch 10: 语义化 Prompt 加载器 -- 基于文件的会话上下文注入

## 为什么要改 (Why)

### 问题 1: 字节分块加载器的顺序依赖性

旧版 CLI runner 将系统 prompt 切成多个固定大小的 chunk 文件，要求 Claude 严格按顺序读取（chunk 0 -> chunk 1 -> chunk 2...）。如果 Claude 并行读取或乱序读取，验证状态机会判定失败并触发重试循环，浪费 token 和延迟。

### 问题 2: 工作区文件内容重复

旧加载器将 AGENTS.md、SOUL.md 等工作区上下文文件的内容直接内联到系统 prompt 字符串中，再写入 chunk 文件。这导致同一份文件内容在 prompt 中出现两次 —— 一次是原始文件（Claude CLI 可能自动加载），一次是内联副本，造成 token 浪费。

### 问题 3: 缺失文件的无限重试

当某个 prompt chunk 文件在磁盘上不存在（例如被清理或路径错误），旧验证器会不断要求 Claude 重新读取，陷入无限重试循环，最终触发超时而非优雅跳过。

### 问题 4: 会话绑定元数据不完整

旧版 session binding 只保存 chunk-based 的 `systemPromptFile` / `systemPromptHash`，无法表达语义化加载器的文件集合和 hash 状态，导致 resume 时无法判断 prompt 是否需要重新加载。

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `src/agents/cli-runner/semantic-prompt.ts` | **新文件**：语义化 prompt 加载器核心 -- 写会话文件、构建 loader prompt、构建 completion prompt、Set-based 文件匹配 |
| `src/agents/cli-runner/flags.ts` | **新文件**：`ENABLE_SEMANTIC_PROMPT_LOADER` 特性开关，控制新旧加载器切换 |
| `src/agents/cli-runner/execute.ts` | 在 `executeWithOverflowProtection` 中加入语义加载器路径：写会话文件、构建 loader prompt、Set-based 验证（tool_use/tool_result）、completion prompt 生成、binding 持久化 |
| `src/agents/cli-runner/helpers.ts` | `buildSystemPrompt` 调用 `buildAgentSystemPromptSplit` 剥离内联工作区文件内容 |
| `src/agents/system-prompt.ts` | 新增 `buildAgentSystemPromptSplit` 函数：支持 `omitContextFileContent` 参数，替换悬空 header |
| `src/agents/cli-session.ts` | `getCliSessionBinding` 和 `setCliSessionBinding` 增加语义化字段的读写 |
| `src/config/sessions/types.ts` | `CliSessionBinding` 类型新增 `semanticContextFiles`、`semanticSessionFile`、`semanticSessionHash`、`semanticCompactionCount` 字段 |
| `src/agents/cli-runner.ts` | `runCliAgent` 的返回值中传播语义化 binding 字段到上层调用者 |
| `src/agents/cli-runner/semantic-prompt.test.ts` | **新文件**：231 行测试覆盖写文件、loader prompt 构建、completion prompt、文件匹配和 expected files 集合 |

## 伪代码 (Pseudocode)

### 1. 写入语义化会话文件 (`writeSemanticSessionFile`)

```javascript
async function writeSemanticSessionFile({ sessionFile, sessionPromptContent }) {
  // 基于 session 文件路径生成 .system-prompt.txt 路径
  const filePath = sessionDir + "/" + baseName + ".system-prompt.txt"

  // 确保内容以换行结尾
  if (!content.endsWith("\n")) content += "\n"

  // 计算内容 hash（用于后续变更检测）
  const hash = hashCliSessionText(content)

  // 仅在内容变更时才写磁盘（避免无谓 I/O）
  const existing = tryReadFile(filePath)
  if (existing !== content) {
    writeFile(filePath, content, { mode: 0o600 })  // 权限限制为 owner-only
  }

  return { filePath, hash }
}
```

### 2. 构建语义化 Loader Prompt (`buildSemanticLoaderPrompt`)

```javascript
function buildSemanticLoaderPrompt({ files, reason, strict }) {
  const lines = []

  // strict 模式：上次读取失败，强制重读
  if (strict) lines.push("上次未成功读取，必须在本轮读取所有文件")

  // 根据原因添加上下文提示
  if (reason === "compaction") lines.push("会话已被压缩，必须重新读取")
  if (reason === "prompt-changed") lines.push("prompt 文件已变更，必须重新读取")

  // 核心指令：允许并行、无序读取
  lines.push("MANDATORY FIRST STEP: 用 Read 工具读取以下所有文件")
  lines.push("可以任意顺序并行读取")

  // session 文件排第一，工作区文件在后
  const allPaths = [files.sessionFile, ...files.contextFiles]
  allPaths.forEach((p, i) => lines.push(`${i + 1}. ${p}`))

  // 缺失文件跳过（不重试），内容为权威 prompt
  lines.push("文件不存在则跳过并继续")
  lines.push("这些文件的组合内容是本会话的权威系统 prompt")

  return lines.join("\n")
}
```

### 3. Set-based 读取验证（execute.ts 中的验证器）

```javascript
// 初始化阶段
const verifiedPromptFileSets = new Map()  // sessionId -> Set<verifiedPath>

// tool_use 事件处理
onToolUse(name, input, toolUseId) {
  if (name !== "Read") return
  const filePath = resolve(input.filePath)

  // 检查是否是预期的 prompt 文件
  if (!isExpectedSemanticPromptFile(semanticFiles, filePath)) return

  // 检测部分读取（有 offset 或 limit）
  const partialRead = hasOffset(input) || hasLimit(input)

  // 记录待验证的读取请求
  promptFileReadRequests.set(toolUseId, { filePath, partialRead })
}

// tool_result 事件处理
onToolResult(toolUseId, text, isError) {
  const request = promptFileReadRequests.get(toolUseId)
  if (!request) return

  const expectedFiles = resolveSemanticExpectedFiles(semanticFiles)

  if (isError) {
    // 文件不存在 → 标记为"确认缺失"，加入已验证集合（不重试）
    verifiedSet.add(request.filePath)
  } else if (request.partialRead || looksLikeTruncated(text)) {
    // 部分读取 → 不算通过
    promptFileReadAttemptedPartially = true
  } else {
    // 完整读取 → 加入已验证集合（无需顺序检查）
    verifiedSet.add(request.filePath)
  }

  // 所有预期文件都已验证 → 通过
  promptFileReadVerified = verifiedSet.size >= expectedFiles.size
}
```

### 4. 悬空 Header 替换 (`buildAgentSystemPromptSplit`)

```javascript
function buildAgentSystemPromptSplit({ omitContextFileContent, contextFiles, ...rest }) {
  if (!omitContextFileContent) return buildAgentSystemPrompt(params)

  // 构建不含工作区文件内容的 prompt
  const promptWithoutContext = buildAgentSystemPrompt({ ...rest, contextFiles: [] })

  // 替换悬空的 "Workspace Files (injected)" header
  const danglingHeader = "## Workspace Files (injected)\nThese user-editable files..."
  if (contextFilePaths.length > 0) {
    // 替换为文件引用列表
    const referenceBlock = "## Workspace Files\n" +
      contextFilePaths.map(p => `- ${p}`).join("\n")
    return promptWithoutContext.replace(danglingHeader, referenceBlock)
  } else {
    // 无工作区文件 → 直接删除 header
    return promptWithoutContext.replace(danglingHeader + "\n", "")
  }
}
```

## 数据流程图 (Data Flow Diagram)

### 语义化 Prompt 加载完整流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                    executeWithOverflowProtection                     │
│                                                                     │
│  ┌──────────────────┐    ┌──────────────────────────────────────┐   │
│  │ buildSystemPrompt │    │ writeSemanticSessionFile              │   │
│  │ (helpers.ts)      │    │ (semantic-prompt.ts)                  │   │
│  │                   │    │                                      │   │
│  │ buildAgentSystem- │    │  sessionPromptContent ──► .system-   │   │
│  │ PromptSplit()     │    │                          prompt.txt  │   │
│  │  ↓                │    │  hash = SHA256(content)              │   │
│  │ omitContextFile-  │    └──────────┬───────────────────────────┘   │
│  │ Content: true     │               │                               │
│  │  ↓                │               ▼                               │
│  │ 剥离内联文件内容   │    ┌──────────────────────────────────────┐   │
│  │ 替换悬空 header    │    │ buildSemanticLoaderPrompt            │   │
│  └──────────────────┘    │                                      │   │
│                           │  reason: new-session / compaction /  │   │
│                           │          prompt-changed              │   │
│                           │                                      │   │
│                           │  输出: "Read 以下文件 (可并行):"      │   │
│                           │  1. /path/sess.system-prompt.txt     │   │
│                           │  2. /workspace/AGENTS.md             │   │
│                           │  3. /workspace/SOUL.md               │   │
│                           └──────────┬───────────────────────────┘   │
│                                      │                               │
│                                      ▼                               │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │              Claude CLI 子进程执行                                │ │
│  │                                                                 │ │
│  │  Claude 收到 loader prompt → 并行调用 Read tool                  │ │
│  │       ↓              ↓              ↓                           │ │
│  │  Read(sess.txt)  Read(AGENTS.md)  Read(SOUL.md)                │ │
│  └───────┬──────────────┬──────────────┬───────────────────────────┘ │
│          │              │              │                             │
│          ▼              ▼              ▼                             │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │            Set-based 验证器 (execute.ts)                         │ │
│  │                                                                 │ │
│  │  expectedFiles = Set { sess.txt, AGENTS.md, SOUL.md }          │ │
│  │  verifiedSet   = Set { }                                       │ │
│  │                                                                 │ │
│  │  onToolResult(sess.txt, ok)   → verifiedSet.add(sess.txt)      │ │
│  │  onToolResult(SOUL.md, ok)    → verifiedSet.add(SOUL.md)       │ │
│  │  onToolResult(AGENTS.md, err) → verifiedSet.add(AGENTS.md)     │ │
│  │       (缺失文件也计为已验证，不重试)                               │ │
│  │                                                                 │ │
│  │  verifiedSet.size(3) >= expectedFiles.size(3) → PASS            │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                      │                               │
│                                      ▼                               │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │          Session Binding 持久化 (cli-session.ts)                 │ │
│  │                                                                 │ │
│  │  setCliSessionBinding({                                         │ │
│  │    semanticContextFiles: [AGENTS.md, SOUL.md],                  │ │
│  │    semanticSessionFile: sess.system-prompt.txt,                 │ │
│  │    semanticSessionHash: "abc123",                               │ │
│  │    semanticCompactionCount: 0                                   │ │
│  │  })                                                             │ │
│  │                                                                 │ │
│  │  → 下次 resume 时比对 hash，相同则跳过重读                        │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### resume 时的变更检测流程

```
┌─ matchingCliSessionBinding (从 session store 读取) ─┐
│  semanticContextFiles: [AGENTS.md, SOUL.md]          │
│  semanticSessionHash: "abc123"                       │
│  semanticCompactionCount: 0                          │
└───────────────────────┬──────────────────────────────┘
                        │
                        ▼
              ┌─────────────────┐
              │  变更检测逻辑     │
              │                 │
              │  contextFiles   │──── 不同 ──→ reason="prompt-changed"
              │  相同?           │
              │       │         │
              │       ▼ 相同    │
              │  sessionHash    │──── 不同 ──→ reason="prompt-changed"
              │  相同?           │
              │       │         │
              │       ▼ 相同    │
              │  compaction-    │──── 增加 ──→ reason="compaction"
              │  Count 增加?    │
              │       │         │
              │       ▼ 不变    │
              │  reloadReason   │──── undefined → 跳过重读 (trusted)
              └─────────────────┘
```

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/agents/cli-runner/semantic-prompt.ts` | 5-9 | `SemanticPromptFiles` 类型定义：contextFiles、sessionFile、sessionHash |
| `src/agents/cli-runner/semantic-prompt.ts` | 11-39 | `writeSemanticSessionFile`：写入会话文件，hash 对比跳过无变更写入，mode 0o600 |
| `src/agents/cli-runner/semantic-prompt.ts` | 41-89 | `buildSemanticLoaderPrompt`：构建 loader 指令，支持 strict/compaction/prompt-changed |
| `src/agents/cli-runner/semantic-prompt.ts` | 91-114 | `buildSemanticCompletionPrompt`：构建未验证文件的补充读取指令 |
| `src/agents/cli-runner/semantic-prompt.ts` | 117-124 | `isExpectedSemanticPromptFile`：判断文件路径是否在预期集合中 |
| `src/agents/cli-runner/semantic-prompt.ts` | 126-133 | `resolveSemanticExpectedFiles`：将 contextFiles + sessionFile 合并为 Set |
| `src/agents/cli-runner/flags.ts` | 16-17 | `ENABLE_SEMANTIC_PROMPT_LOADER = true` 特性开关 |
| `src/agents/cli-runner/execute.ts` | 329-413 | 语义加载器主路径：写文件、变更检测、构建 loader prompt |
| `src/agents/cli-runner/execute.ts` | 723-776 | tool_use 事件处理器：Set-based 语义验证，匹配预期文件 |
| `src/agents/cli-runner/execute.ts` | 832-890 | tool_result 事件处理器：缺失文件跳过、截断检测、Set 累积 |
| `src/agents/cli-runner/execute.ts` | 1059-1081 | 验证失败时抛出 `PromptFileReadRequiredError`，附带 unverifiedPaths |
| `src/agents/cli-runner/execute.ts` | 1091-1137 | 语义 binding 持久化：验证通过或信任延续时保存元数据 |
| `src/agents/cli-runner/helpers.ts` | 122-132 | `buildSystemPrompt` 调用 `buildAgentSystemPromptSplit`，`omitContextFileContent: true` |
| `src/agents/system-prompt.ts` | 773-822 | `buildAgentSystemPromptSplit`：omit 模式下剥离内容、替换悬空 header |
| `src/agents/cli-session.ts` | 45-57 | `getCliSessionBinding` 读取语义化字段 |
| `src/agents/cli-session.ts` | 119-140 | `setCliSessionBinding` 写入语义化字段 |
| `src/config/sessions/types.ts` | 79-83 | `CliSessionBinding` 类型扩展：4 个语义化字段 |
| `src/agents/cli-runner.ts` | 69-76 | `runCliAgent` 返回值中传播语义 binding 字段（首次运行路径） |
| `src/agents/cli-runner.ts` | 132-139 | `runCliAgent` 返回值中传播语义 binding 字段（followup 路径） |
