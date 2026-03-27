# OpenClaw Memory 实现机制（源码对照）

> 本文从**业界常见的 Agent Memory 表述**出发，对照本仓库实现，并给出**可核验的源码位置**。用户向文档见 [Memory](/concepts/memory)；配置项见 [Memory config](/reference/memory-config)。

---

## 1. 与业界概念的对应关系

在 LLM Agent 相关讨论里，「记忆」常被粗分为：

| 常见说法               | 含义                                 | OpenClaw 中的对应                                                            |
| ---------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| **短期 / 工作记忆**    | 当前对话、模型上下文窗口内的信息     | Pi session 转写、未压缩前的 `AgentMessage` 序列（见 embedded runner 文档）   |
| **长期 / 外置记忆**    | 超出窗口后仍可持久化的信息           | **工作区 Markdown**（`MEMORY.md`、`memory/*.md` 等），由模型通过文件工具写入 |
| **检索增强（RAG 式）** | 用查询从外置库取回相关片段再拼进提示 | **`memory_search`**（语义检索）+ **`memory_get`**（按路径读片段）            |
| **索引**               | 为加速检索对原文分块、向量化         | 默认 **`MemoryIndexManager`**：SQLite 存 chunk + embedding，可选 FTS/hybrid  |

本仓库的**显式设计**是：Markdown 文件为 **source of truth**；检索层是**派生索引**，用于 `memory_search`，见用户向说明：

```11:12:docs/concepts/memory.md
OpenClaw memory is **plain Markdown in the agent workspace**. The files are the
source of truth; the model only "remembers" what gets written to disk.
```

---

## 2. 组件与目录组织

| 能力               | 主要职责                                                       | 典型入口文件                                                                          |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Agent 工具         | `memory_search` / `memory_get`                                 | `src/agents/tools/memory-tool.ts`                                                     |
| 配置合并           | `agents.defaults.memorySearch` + 按 agent 覆盖、`enabled` 门控 | `src/agents/memory-search.ts` → `resolveMemorySearchConfig`                           |
| 搜索管理器         | 解析后端（builtin / QMD）、缓存                                | `src/memory/search-manager.ts` → `getMemorySearchManager`                             |
| 内置索引           | 分块、embedding、同步、查询                                    | `src/memory/manager.ts`（`MemoryIndexManager`）                                       |
| SQLite 结构        | `files` / `chunks` / FTS / embedding cache                     | `src/memory/memory-schema.ts`                                                         |
| 路径判定           | 何为「记忆文件」路径                                           | `src/memory/internal.ts` → `isMemoryPath`                                             |
| 压缩前落盘         | **Memory flush** 受限工具运行                                  | `src/auto-reply/reply/memory-flush.ts`、`src/auto-reply/reply/agent-runner-memory.ts` |
| Flush 时工具白名单 | 仅 `read` + 对单日文件的 append-only `write`                   | `src/agents/pi-tools.ts`                                                              |

---

## 3. Memory 存在哪里（两层存储）

### 3.1 用户可见的「真相」：工作区 Markdown

工具说明中写明了检索范围包含 `MEMORY.md` 与 `memory/*.md`（以及配置扩展）：

```50:54:src/agents/tools/memory-tool.ts
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
```

路径是否算「记忆路径」在 `isMemoryPath` 中硬编码约定：

```74:83:src/memory/internal.ts
export function isMemoryPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  if (normalized === "MEMORY.md" || normalized === "memory.md") {
    return true;
  }
  return normalized.startsWith("memory/");
}
```

### 3.2 检索索引：按 agent 划分的 SQLite

默认库路径在 `resolveStorePath`：状态目录下 `memory/<agentId>.sqlite`，可通过配置模板 `{agentId}` 覆盖：

```133:141:src/agents/memory-search.ts
function resolveStorePath(agentId: string, raw?: string): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  const fallback = path.join(stateDir, "memory", `${agentId}.sqlite`);
  if (!raw) {
    return fallback;
  }
  const withToken = raw.includes("{agentId}") ? raw.replaceAll("{agentId}", agentId) : raw;
  return resolveUserPath(withToken);
}
```

表结构（节选）体现「文件元数据 + 分块 + 向量列」组织方式：

```16:37:src/memory/memory-schema.ts
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
```

配置里还可选 **`memory.backend: qmd`**，走外部 QMD 进程与集合，解析见 `src/memory/backend-config.ts`（与 builtin 并行存在）。

---

## 4. 索引如何构建与更新（组织逻辑）

### 4.1 配置项：`mergeConfig` 中的 chunk、sync、hybrid

默认分块约 400 token、overlap 80（常量见 `src/agents/memory-search.ts` 中 `DEFAULT_CHUNK_*`），以及 `sync.onSessionStart` / `onSearch` / `watch` 等，均在 `mergeConfig` 合并进 `ResolvedMemorySearchConfig`（`src/agents/memory-search.ts`）。

### 4.2 数据源：`memory` 与可选 `sessions`

`sources` 可包含索引会话转写（受 `experimental.sessionMemory` 等约束），归一化逻辑：

```113:131:src/agents/memory-search.ts
function normalizeSources(
  sources: Array<"memory" | "sessions"> | undefined,
  sessionMemoryEnabled: boolean,
): Array<"memory" | "sessions"> {
  const normalized = new Set<"memory" | "sessions">();
  const input = sources?.length ? sources : DEFAULT_SOURCES;
  for (const source of input) {
    if (source === "memory") {
      normalized.add("memory");
    }
    if (source === "sessions" && sessionMemoryEnabled) {
      normalized.add("sessions");
    }
  }
  if (normalized.size === 0) {
    normalized.add("memory");
  }
  return Array.from(normalized);
}
```

### 4.3 搜索管理器：builtin 与 QMD

`getMemorySearchManager` 先按 `resolveMemoryBackendConfig` 判断是否走 QMD，否则懒加载 `MemoryIndexManager`：

```25:85:src/memory/search-manager.ts
export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemorySearchManagerResult> {
  const resolved = resolveMemoryBackendConfig(params);
  if (resolved.backend === "qmd" && resolved.qmd) {
    // ... QmdMemoryManager.create ...
  }

  try {
    const { MemoryIndexManager } = await loadManagerRuntime();
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}
```

---

## 5. 何时「启用」memory 工具与检索

`memory_search` / `memory_get` 仅在 `resolveMemorySearchConfig` 返回非 `null` 时注册（`enabled: false` 时整段关闭）：

```378:387:src/agents/memory-search.ts
export function resolveMemorySearchConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedMemorySearchConfig | null {
  const defaults = cfg.agents?.defaults?.memorySearch;
  const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
  const resolved = mergeConfig(defaults, overrides, agentId);
  if (!resolved.enabled) {
    return null;
  }
```

`memory-tool.ts` 中若上下文解析失败则**不暴露工具**：

```25:37:src/agents/tools/memory-tool.ts
function resolveMemoryToolContext(options: { config?: OpenClawConfig; agentSessionKey?: string }) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}
```

---

## 6. 何时把内容「写入」长期记忆（触发与路径）

OpenClaw **没有**单独的 `save_memory` API；持久化依赖：

1. **正常运行**：模型用 `write` 等工具写入 `MEMORY.md` / `memory/…`（与普通文件相同）。
2. **压缩前的 Memory flush（自动）**：会话接近上下文上限时，插入一次 **`trigger === "memory"`** 的受限运行，只允许少量工具，且 **`write` 被包装为仅可向当日 `memory/YYYY-MM-DD.md` 追加**。

Flush 是否执行由 `runMemoryFlushIfNeeded` 汇总 token 投影、会话日志字节数、`shouldRunMemoryFlush` 等判断：

```634:652:src/auto-reply/reply/agent-runner-memory.ts
  const shouldFlushMemory =
    (memoryFlushSettings &&
      memoryFlushWritable &&
      !params.isHeartbeat &&
      !isCli &&
      shouldRunMemoryFlush({
        entry,
        tokenCount: tokenCountForFlush,
        contextWindowTokens,
        reserveTokensFloor: memoryFlushSettings.reserveTokensFloor,
        softThresholdTokens: memoryFlushSettings.softThresholdTokens,
      })) ||
    (shouldForceFlushByTranscriptSize &&
      entry != null &&
      !hasAlreadyFlushedForCurrentCompaction(entry));

  if (!shouldFlushMemory) {
    return entry ?? params.sessionEntry;
  }
```

基于 token 的阈值逻辑在 `shouldRunMemoryFlush`（上下文窗口 − 预留 − soft 阈值）：

```170:214:src/auto-reply/reply/memory-flush.ts
export function shouldRunMemoryFlush(params: {
  entry?: Pick<
    SessionEntry,
    "totalTokens" | "totalTokensFresh" | "compactionCount" | "memoryFlushCompactionCount"
  >;
  tokenCount?: number;
  contextWindowTokens: number;
  reserveTokensFloor: number;
  softThresholdTokens: number;
}): boolean {
  if (!params.entry) {
    return false;
  }
  // ...
  const threshold = Math.max(0, contextWindow - reserveTokens - softThreshold);
  // ...
  if (totalTokens < threshold) {
    return false;
  }

  if (hasAlreadyFlushedForCurrentCompaction(params.entry)) {
    return false;
  }

  return true;
}
```

受限工具集与 **仅允许追加到指定相对路径** 的 `write`：

```535:552:src/agents/pi-tools.ts
  const toolsForMemoryFlush =
    isMemoryFlushRun && memoryFlushWritePath
      ? tools.flatMap((tool) => {
          if (!MEMORY_FLUSH_ALLOWED_TOOL_NAMES.has(tool.name)) {
            return [];
          }
          if (tool.name === "write") {
            return [
              wrapToolMemoryFlushAppendOnlyWrite(tool, {
                root: sandboxRoot ?? workspaceRoot,
                relativePath: memoryFlushWritePath,
```

（`MEMORY_FLUSH_ALLOWED_TOOL_NAMES` 在同一文件内定义为 `["read", "write"]`。）

同一文件要求 memory flush 运行必须带 `memoryFlushWritePath`：

```273:277:src/agents/pi-tools.ts
  const isMemoryFlushRun = options?.trigger === "memory";
  if (isMemoryFlushRun && !options?.memoryFlushWritePath) {
    throw new Error("memoryFlushWritePath required for memory-triggered tool runs");
  }
```

**另：** 当持久化 token 陈旧时，`runPreflightCompactionIfNeeded` 可能在正式回复前触发 **预压缩**（`compactEmbeddedPiSession`），与「把记忆写入 md」不同，但同属「上下文将满」时的系统行为，见 `src/auto-reply/reply/agent-runner-memory.ts` 中 `runPreflightCompactionIfNeeded`。

---

## 7. 检索调用链（agent 如何「找到」记忆）

1. 模型调用 **`memory_search`** → `getMemorySearchManager` → 后端 `search(query, …)`。
2. 需要全文再调用 **`memory_get`** → `manager.readFile({ relPath, from, lines })`。

执行入口：

```55:76:src/agents/tools/memory-tool.ts
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult(buildMemorySearchUnavailableResult(error));
      }
      try {
        const citationsMode = resolveMemoryCitationsMode(cfg);
        const includeCitations = shouldIncludeCitations({
          mode: citationsMode,
          sessionKey: options.agentSessionKey,
        });
        const rawResults = await manager.search(query, {
          maxResults,
          minScore,
          sessionKey: options.agentSessionKey,
        });
```

CLI 侧有 **`openclaw memory status|index|search`**（`src/cli/memory-cli.ts`），用于运维与脚本，与 agent 工具共用同一套 manager。

---

## 8. 小结表

| 问题                 | 结论                                                          | 源码锚点                                                              |
| -------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| 记忆存在哪？         | 工作区 `MEMORY.md` / `memory/**`；索引在状态目录 `*.sqlite`   | `internal.ts` `isMemoryPath`；`memory-search.ts` `resolveStorePath`   |
| 如何索引？           | 文件 → chunk → embedding 写入 SQLite（+ 可选 FTS/hybrid/QMD） | `memory-schema.ts`；`manager.ts`；`search-manager.ts`                 |
| 何时能搜？           | `memorySearch.enabled` 且配置合法                             | `resolveMemorySearchConfig`                                           |
| 何时自动往 md 里写？ | 接近 compaction 的 memory flush；或任意回合模型主动 `write`   | `agent-runner-memory.ts`；`memory-flush.ts`；`pi-tools.ts` flush 包装 |
| 如何查找？           | `memory_search` + `memory_get`                                | `memory-tool.ts`                                                      |

---

## 参考链接（文档站）

- [Memory（概念）](https://docs.openclaw.ai/concepts/memory)
- [Memory CLI](https://docs.openclaw.ai/cli/memory)
- [Memory 配置](https://docs.openclaw.ai/reference/memory-config)
