# OpenClaw Memory 系统内部实现文档

> 本文档面向开发者，描述 Memory 系统的设计、数据格式、触发机制和核心代码位置。

---

## 一、Memory 是什么

Memory 是 OpenClaw 为 Agent 提供的**长期语义记忆能力**。它把工作区的 Markdown 文件（以及可选的对话记录）向量化后存入本地 SQLite 数据库，Agent 在回答问题前通过 `memory_search` 工具检索相关片段注入上下文，实现跨会话的知识积累。

---

## 二、Memory 文件格式与位置

### 2.1 用户侧：记忆文件

Memory 内容以普通 Markdown 文件形式存储在工作区，可被用户直接编辑：

```
<workspaceDir>/
├── MEMORY.md          ← 主记忆文件（最常用）
├── memory.md          ← 备用入口（与上等价）
└── memory/
    ├── people.md
    ├── projects.md
    └── *.md           ← 任意子文件
```

规则：`isMemoryPath()` 函数判定，路径等于 `MEMORY.md` / `memory.md`，或以 `memory/` 开头的 `.md` 文件。

> 核心代码：`src/memory/internal.ts:isMemoryPath()`

### 2.2 系统侧：向量索引数据库

索引以 SQLite 存储，默认路径由配置决定（`memory.store.path`）：

```
~/.openclaw/agents/<agentId>/memory/index.db
```

**数据库 Schema：**

```sql
-- 已索引的文件记录（用于增量同步判断）
CREATE TABLE files (
  path    TEXT PRIMARY KEY,
  source  TEXT NOT NULL DEFAULT 'memory',  -- 'memory' | 'sessions'
  hash    TEXT NOT NULL,    -- 文件内容 SHA256
  mtime   INTEGER NOT NULL,
  size    INTEGER NOT NULL
);

-- 文档分块（核心存储单元）
CREATE TABLE chunks (
  id         TEXT PRIMARY KEY,   -- UUID
  path       TEXT NOT NULL,
  source     TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  model      TEXT NOT NULL,      -- embedding 模型标识
  text       TEXT NOT NULL,      -- 原始文本片段
  embedding  TEXT NOT NULL,      -- JSON 序列化的 float 向量
  updated_at INTEGER NOT NULL
);

-- FTS5 全文检索虚拟表（hybrid 模式使用）
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, id UNINDEXED, path UNINDEXED, source UNINDEXED,
  model UNINDEXED, start_line UNINDEXED, end_line UNINDEXED
);

-- sqlite-vec ANN 向量表（可选，需要 sqlite-vec 扩展）
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[<dims>]
);

-- Embedding 结果缓存（避免重复调用外部 API）
CREATE TABLE embedding_cache (
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  hash        TEXT NOT NULL,
  embedding   TEXT NOT NULL,
  dims        INTEGER,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
);

-- 索引元数据（记录 provider/model/chunk 参数，用于判断是否需要全量重建）
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

> 核心代码：`src/memory/memory-schema.ts`

---

## 三、Memory 数据来源（Sources）

Memory 支持两种数据来源，可同时启用：

| Source     | 内容                                                         | 同步触发条件                                            |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| `memory`   | 工作区 `MEMORY.md` + `memory/*.md` 文件                      | 文件变更（chokidar 监听）、搜索时检测到 dirty、定时同步 |
| `sessions` | Agent 对话记录（`~/.openclaw/agents/<id>/sessions/*.jsonl`） | 对话记录写入事件、定时同步                              |

---

## 四、索引同步：什么时候触发

### 4.1 自动触发场景

```
触发场景                    代码位置
─────────────────────────────────────────────────────────────
文件系统变更                manager-sync-ops.ts:ensureWatcher()
  MEMORY.md / memory/*.md  chokidar → dirty=true → scheduleWatchSync()
  debounce 后执行 sync()

Session 记录写入            manager-sync-ops.ts:ensureSessionListener()
  对话 JSONL 追加新内容     onSessionTranscriptUpdate → scheduleSessionDirty()
  5s debounce → 累积字节/消息数达阈值 → sync()

搜索时检测到 dirty          manager.ts:search()
  sync.onSearch=true 时     dirty||sessionsDirty → 异步触发 sync()

Session 开始时预热          manager.ts:warmSession()
  sync.onSessionStart=true  异步触发 sync()

定时同步                    manager-sync-ops.ts:ensureIntervalSync()
  intervalMinutes > 0       setInterval → sync()
```

### 4.2 手动触发

```bash
# CLI 命令（会调用 manager.sync({ force: true })）
openclaw memory sync
```

### 4.3 同步流程

```
sync()
  │
  ├─ 检查 meta（模型/provider/chunk参数是否变化）
  │       │
  │       ├─ 变化 → runSafeReindex()     ← 原子重建（tmp db → swap）
  │       └─ 未变 → 增量同步
  │                    │
  │                    ├─ syncMemoryFiles()   ← 按文件 hash 判断是否重新嵌入
  │                    └─ syncSessionFiles()  ← 只处理 dirty 的 session 文件
  │
  └─ 写入 meta（记录当前 model/provider/chunk 参数）
```

> 核心代码：`src/memory/manager-sync-ops.ts:runSync()` / `runSafeReindex()`

---

## 五、文档分块（Chunking）

文件读取后按 token 数切分为 chunks：

- 参数：`chunking.tokens`（默认约 400 token）、`chunking.overlap`（相邻 chunk 重叠 token 数）
- 每个 chunk 记录：`startLine`、`endLine`、原始文本、embedding 向量

> 核心代码：`src/memory/manager-embedding-ops.ts:indexFile()`

---

## 六、Embedding 提供商

| 提供商    | 说明                  | 默认模型                 |
| --------- | --------------------- | ------------------------ |
| `openai`  | OpenAI Embeddings API | `text-embedding-3-small` |
| `gemini`  | Google Gemini         | `text-embedding-004`     |
| `voyage`  | Voyage AI             | `voyage-3-lite`          |
| `mistral` | Mistral AI            | `mistral-embed`          |
| `local`   | 本地 llama.cpp        | 取决于本地模型           |
| `remote`  | 自定义远程 HTTP 端点  | 配置决定                 |

提供商不可用时自动 fallback（由 `memory.fallback` 配置决定）。

> 核心代码：`src/memory/embeddings.ts:createEmbeddingProvider()`

---

## 七、搜索实现

Agent 调用 `memory_search` 时，执行如下流程：

### 7.1 三种搜索模式

```
有 embedding provider？
    │
    ├─ 否 → FTS-only 模式
    │        extractKeywords(query) → 多关键词并行 BM25 搜索 → 合并去重
    │
    ├─ 是 + hybrid=false → 纯向量模式
    │        embedQuery() → vec_distance_cosine 排序
    │
    └─ 是 + hybrid=true（默认）→ 混合搜索
             BM25 关键词搜索
                  +
             向量余弦相似度搜索
                  │
             mergeHybridResults()
             （vectorWeight × 向量分 + textWeight × BM25分）
                  │
             applyMMR()            ← 多样性重排（Maximal Marginal Relevance，可选）
                  │
             applyTemporalDecay()  ← 时间衰减加权（可选）
```

### 7.2 向量搜索底层

- **优先**：使用 `sqlite-vec` 扩展的 `vec_distance_cosine()`（ANN 近似最近邻）
- **降级**：`sqlite-vec` 不可用时，在内存中暴力遍历所有 chunk 计算余弦相似度

> 核心代码：`src/memory/manager-search.ts:searchVector()` / `searchKeyword()`

### 7.3 FTS 查询构建

```
"tell me about the API design"
        │
   extractKeywords()
        │
  ["tell", "about", "API", "design"]
        │
  buildFtsQuery()
        │
  '"tell" AND "about" AND "API" AND "design"'
        │
  SQLite FTS5 MATCH
```

> 核心代码：`src/memory/hybrid.ts:buildFtsQuery()`

---

## 八、工具接口

### `memory_search`

```typescript
// 参数
{ query: string; maxResults?: number; minScore?: number }

// 返回
{
  results: Array<{
    path: string;         // 相对路径，如 "MEMORY.md" / "memory/people.md"
    startLine: number;
    endLine: number;
    score: number;        // 0~1，越高越相关
    snippet: string;      // 原始文本片段（最多 700 字符）
    source: "memory" | "sessions";
    citation?: string;    // "MEMORY.md#L12-L15"（citations 开启时）
  }>;
  provider: string;
  model?: string;
  disabled?: boolean;     // true 表示不可用（API 配额耗尽等）
}
```

### `memory_get`

```typescript
// 参数
{ path: string; from?: number; lines?: number }

// 用途：search 返回片段后，按行号精确拉取完整段落
```

> 核心代码：`src/agents/tools/memory-tool.ts`

---

## 九、System Prompt 中的 Memory 章节

`memory_search` / `memory_get` 工具存在时，自动在 System Prompt 中插入：

```
## Memory Recall
Before answering anything about prior work, decisions, dates, people,
preferences, or todos: run memory_search on MEMORY.md + memory/*.md;
then use memory_get to pull only the needed lines.
```

> 核心代码：`src/agents/system-prompt.ts:buildMemorySection()`

---

## 十、核心代码索引

| 功能                                            | 文件                                               |
| ----------------------------------------------- | -------------------------------------------------- |
| 工具定义（memory_search / memory_get）          | `src/agents/tools/memory-tool.ts`                  |
| Manager 工厂（后端选择 + fallback）             | `src/memory/search-manager.ts`                     |
| 内置 Manager 主类（search / readFile / status） | `src/memory/manager.ts`                            |
| 同步逻辑（watch / session delta / 定时 / 重建） | `src/memory/manager-sync-ops.ts`                   |
| Embedding 操作（分块 / 向量化 / 缓存）          | `src/memory/manager-embedding-ops.ts`              |
| 向量 + 关键词底层搜索                           | `src/memory/manager-search.ts`                     |
| 混合搜索 Fusion（BM25 + 向量加权合并）          | `src/memory/hybrid.ts`                             |
| MMR 多样性重排                                  | `src/memory/mmr.ts`                                |
| 时间衰减加权                                    | `src/memory/temporal-decay.ts`                     |
| 关键词提取（FTS-only 模式）                     | `src/memory/query-expansion.ts`                    |
| SQLite Schema 定义                              | `src/memory/memory-schema.ts`                      |
| 文件扫描 + 分块工具函数                         | `src/memory/internal.ts`                           |
| sqlite-vec 扩展加载                             | `src/memory/sqlite-vec.ts`                         |
| Embedding 提供商工厂                            | `src/memory/embeddings.ts`                         |
| System Prompt 中 Memory 章节                    | `src/agents/system-prompt.ts:buildMemorySection()` |
| 内存配置解析                                    | `src/agents/memory-search.ts`                      |

---

## 十一、端到端数据流

```
用户编辑 MEMORY.md
      │
      ▼ chokidar 文件监听（ensureWatcher）
dirty = true
      │
      ▼ scheduleWatchSync（debounce）
sync({ reason: "watch" })
      │
      ├─ 读取文件 → buildFileEntry → SHA256 hash
      ├─ 对比 DB 中旧 hash（跳过未变更文件）
      ├─ 切分 chunk（按 token 数）
      ├─ 调用 Embedding API（或命中本地 cache）
      └─ 写入 chunks + chunks_vec + chunks_fts
            │
            ▼
用户发送消息给 Agent
            │
            ▼ System Prompt 提示 Agent 先执行 memory_search
Agent 调用 memory_search(query)
            │
            ├─ embedQueryWithTimeout(query)   → 查询向量
            ├─ searchVector(queryVec)          → sqlite-vec ANN
            ├─ searchKeyword(query)            → FTS5 BM25
            └─ mergeHybridResults              → 融合排序
                        │
                        ▼ 返回 top-K snippets
            Agent 将 snippets 注入上下文 → 生成回复
```
