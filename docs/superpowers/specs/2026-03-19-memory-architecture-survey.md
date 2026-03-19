# OpenClaw Memory 架构调查报告

**日期**: 2026-03-19
**作者**: Claude Code
**状态**: 已完成

---

## 一、架构总览

OpenClaw 的 Memory 系统是一个**混合语义搜索系统**，采用多层、多后端设计，核心基于 SQLite + 向量扩展，提供语义搜索与全文搜索的融合能力。

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MemorySearchManager                           │
│                    (src/memory/types.ts:61)                         │
└─────────────────────────────────────────────────────────────────────┘
                    ▲                              ▲
         ┌─────────┴──────────┐         ┌────────┴────────┐
         │  MemoryIndexManager │         │ QmdMemoryManager │
         │   (Builtin后端)      │         │  (External后端)  │
         └─────────┬──────────┘         └────────┬────────┘
                   │                              │
    ┌──────────────┼──────────────┐    ┌─────────┴────────┐
    │              │              │    │                  │
┌───┴───┐   ┌────┴────┐   ┌────┴─────┐              MCP/QMD
│ Sync  │   │Embedding│   │  Search   │             Protocol
│ Ops   │   │  Ops    │   │ (Hybrid)   │
└───┬───┘   └────┴────┘   └────┬─────┘
    │             │              │
    ▼             ▼              ▼
 ┌─────────────────────────────────────────┐
 │           SQLite Database                │
 │  ┌──────────┐ ┌──────────┐ ┌─────────┐ │
 │  │  chunks  │ │  chunks  │ │embedding│ │
 │  │  (FTS5) │ │  (_vec)  │ │ _cache  │ │
 │  └──────────┘ └──────────┘ └─────────┘ │
 └─────────────────────────────────────────┘
```

---

## 二、核心组件详解

### 2.1 MemoryIndexManager (`src/memory/manager.ts`)

**职责**：内置 Builtin 后端的核心索引管理器

**关键特性**：
- **三层缓存**：内存缓存 (`INDEX_CACHE`) → 进程级复用
- **向后端兼容**：支持 `sqlite-vec` 扩展存储向量，或回退到纯内存 cosine similarity
- **读写混合**：使用 `node:sqlite` 的同步 API (`DatabaseSync`)，但封装了 async 接口
- **脏标记机制**：`dirty` / `sessionsDirty` 标记变更，避免频繁重索引

**设计亮点**：
- **双重降级**：Provider 降级（OpenAI → Gemini → Voyage → Mistral → Ollama → Local） + 后端降级（QMD → Builtin）
- **向量可用性探测**：`probeVectorAvailability()` 在启动时探测 `sqlite-vec` 扩展

### 2.2 混合搜索架构 (`src/memory/hybrid.ts`)

**搜索流程**：
```
Query ──┬──▶ Vector Search ──▶ vectorScore (cosine similarity)
        │                          │
        │                          │ merge
        └──▶ FTS5 BM25 ──▶ textScore ──▶ weighted sum ──▶ MMR/TemporalDecay
```

**可选增强**：
- **MMR (Maximal Marginal Relevance)**：`λ*relevance - (1-λ)*maxSimilarity`，平衡相关性与多样性
- **Temporal Decay**：基于文件日期的指数衰减，常青文件（`MEMORY.md`）豁免

### 2.3 多 Embedding Provider 支持

| Provider | 模型默认 | 批处理 | 多模态输入 |
|----------|---------|--------|-----------|
| OpenAI | `text-embedding-3-small` | ✅ | ✅ (`embedBatchInputs`) |
| Gemini | `gemini-embedding-001` | ✅ | ✅ |
| Voyage | `voyage-4-large` | ✅ | ❌ |
| Mistral | `mistral-embed` | ✅ | ❌ |
| Ollama | `nomic-embed-text` | ✅ | ❌ |
| Local (llama.cpp) | `embeddinggemma-300m-qat-q8_0` | ❌ | ❌ |

**Provider 选择策略**：`auto` 模式按优先级遍历，成功即停

### 2.4 QMD 后端 (`src/memory/backend-config.ts`)

External QMD 后端通过 MCP 协议或直接进程启动，提供：
- 外部维护的向量存储
- 可配置的搜索模式（`search` / `vsearch` / `query`）
- Session 级别的记忆导出与保留策略

### 2.5 记忆分类与生命周期

```
memory-core 插件
    ├── memory_search  ──▶ 语义检索 Builtin Index
    └── memory_get      ──▶ 安全片段读取

memory-lancedb 插件
    ├── memory_recall  ──▶ LanceDB 向量搜索（长期记忆）
    ├── memory_store   ──▶ 重要性/类别标注存储
    ├── memory_forget  ──▶ 按 ID 或查询删除
    └── Auto-Capture   ──▶ 生命周期钩子自动提取
```

**LanceDB 特点**：
- 独立于 SQLite 的持久化向量存储
- 内置 prompt injection 防护（正则模式匹配）
- 语言感知的自动捕获触发器（捷克语/英语混合）

---

## 三、架构优势

### ✅ 3.1 混合搜索设计优秀
- 向量 + BM25 融合，互补性强（语义 vs 关键词）
- MMR 可选去重，避免重复结果
- Temporal decay 支持时间敏感性查询

### ✅ 3.2 多层降级保证可用性
```
Provider降级链：OpenAI → Gemini → Voyage → Mistral → Ollama → Local
后端降级链：QMD → Builtin (SQLite+vec) → FTS-only (无向量)
```
极端情况下仍能提供基于关键词的搜索能力。

### ✅ 3.3 嵌入缓存高效
- SQLite 内嵌缓存表 (`embedding_cache`)，基于 `hash(provider, model, text)` 去重
- 避免重复 embedding 相同文本

### ✅ 3.4 Session 记忆自动同步
- Chokidar 文件监听 + 轮询 interval 双模式
- Session 变更增量跟踪（`sessionDeltas` Map）
- 新 session 文件热启动预热（`sessionWarm` Set）

### ✅ 3.5 插件化扩展
- `memory-core` 将内置能力暴露为插件工具
- `memory-lancedb` 提供独立长期记忆扩展
- Context Engine 可插拔，允许自定义上下文组装策略

### ✅ 3.6 向后兼容与渐进增强
- `probeVectorAvailability()` 优雅探测向量扩展
- FTS-only 降级保证无向量扩展环境下仍可用
- Embedding Provider 按需加载，不强制绑定

---

## 四、架构不足与改进建议

### ❌ 4.1 数据库模型耦合过紧

**问题**：`MemoryIndexManager` 既是索引管理器又直接操作 SQLite schema，职责不清晰。

```typescript
// manager.ts:95
protected db: DatabaseSync;  // 直接暴露数据库实例
```

**风险**：
- 难以独立测试索引逻辑
- Schema 变更影响管理器行为
- 无法切换不同存储后端（如 PostgreSQL + pgvector）

**建议**：
```typescript
// 引入存储抽象层
interface VectorStore {
  upsert(id: string, embedding: number[], metadata: ChunkMeta): Promise<void>;
  search(query: number[], topK: number): Promise<VectorResult[]>;
  delete(ids: string[]): Promise<void>;
}

class SqliteVecStore implements VectorStore { ... }
class LanceDBStore implements VectorStore { ... }
class QdrantStore implements VectorStore { ... }
```

### ❌ 4.2 同步机制过于复杂

**问题**：`MemoryManagerSyncOps` 混合了：
- 文件监听（Chokidar）
- 轮询定时器
- Session 文件增量跟踪
- 启动时同步

```typescript
protected watcher: FSWatcher | null = null;
protected watchTimer: NodeJS.Timeout | null = null;
protected sessionWatchTimer: NodeJS.Timeout | null = null;
protected intervalTimer: NodeJS.Timeout | null = null;
protected sessionDeltas = new Map<string, {...}>();
```

**风险**：多定时器交叉，难调试；Session 增量逻辑与核心索引耦合

**建议**：
- 抽取 `FileWatcher` 抽象，统一监听逻辑
- Session 跟踪抽取为独立的 `SessionTracker` 类
- 考虑用事件驱动的 `EventEmitter` 替代散落的 timer

### ❌ 4.3 缺乏记忆重要性评估

**问题**：当前所有 chunk 等权重，仅靠 `score` 排序。没有记忆"价值"评估机制。

**影响**：
- 老的高价值记忆可能被新的低价值记忆稀释
- LanceDB 的 `importance` 字段在 builtin 索引中未使用

**建议**：
- 引入**记忆元老机制**（类似 RL 的 reward accumulation）
- 高价值记忆自动提升 decay 半衰期
- 或引入"精华记忆"专区，独立索引

### ❌ 4.4 Chunk 策略单一

**问题**：仅基于 token 数量的固定 chunk (`chunkMarkdown`)，无重叠调整、无语义边界感知。

```typescript
// internal.ts:334
const chunks = splitByToken(text, { ...opts, overlap: 0 });  // 无 overlap
```

**建议**：
- 支持 Markdown 标题/段落边界的语义 chunk
- 可配置的 overlap 策略
- 支持自定义 chunk 提取器（通过插件）

### ❌ 4.5 记忆检索与上下文组装耦合

**问题**：`MemorySearchManager` 仅返回 `MemorySearchResult[]`，但检索结果如何注入上下文由 `ContextEngine` 决定。没有清晰的分界。

**建议**：
- 定义 `MemoryContext` 接口，返回结构化上下文对象
- 允许不同 Context Engine 对记忆结果做不同处理（如摘要、引用、截断）

### ❌ 4.6 缺乏记忆一致性保证

**问题**：
- 多 session 并发写入 `memory/` 目录
- 文件 hash + mtime 跟踪在高并发下可能不一致
- 没有乐观锁或版本控制

**建议**：
- 引入 SQLite 事务强化
- 或迁移到支持 MVCC 的存储后端
- 添加记忆冲突检测（同一主题多版本）

### ❌ 4.7 CLI 能力不足

**现状**：`openclaw memory` 仅支持 `status`、`status --deep`、`index`、`search`

**建议**：
- `memory ls` — 列出所有记忆文件
- `memory rm <path>` — 删除特定记忆
- `memory stats` — 记忆使用统计（chunk 数、大小、来源分布）
- `memory reindex` — 强制重建索引

### ❌ 4.8 监控与可观测性不足

**问题**：
- `MemoryProviderStatus` 仅覆盖基本指标
- 无请求延迟分布、缓存命中率、向量可用性趋势等

**建议**：
- 添加 `MemoryMetrics` 接口
- 集成 OpenTelemetry traces
- 导出 Prometheus metrics

### ❌ 4.9 记忆隐私模型缺失

**现状**：DM 政策要求 pairing，但记忆系统无权限边界概念。任何 session 的记忆可能被任何 query 召回。

**建议**：
- 引入**记忆 ACL**：标记记忆来源 session/ channel
- 查询时自动过滤无权限的记忆块
- 与 pairing/allowlist 机制联动

---

## 五、总结评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **功能完整性** | ★★★★☆ | 内核扎实，插件扩展良好，但缺乏记忆价值评估 |
| **搜索质量** | ★★★★☆ | 混合搜索 + MMR + temporal 设计优秀 |
| **可用性/降级** | ★★★★★ | 多层降级，FTS-only 保底 |
| **架构清晰度** | ★★★☆☆ | Manager 过于臃肿，职责分散 |
| **扩展性** | ★★★★☆ | 插件化好，但核心存储抽象不足 |
| **性能** | ★★★☆☆ | Sync 机制复杂，缓存效率可优化 |
| **可测试性** | ★★☆☆☆ | 强耦合 SQLite，难以独立测试 |
| **可观测性** | ★★☆☆☆ | 监控指标匮乏 |

**总体**：设计思想先进（混合搜索、多后端、插件化），但实现层面存在职责耦合、复杂度过高的问题。适合作为 MVP 进一步打磨。
