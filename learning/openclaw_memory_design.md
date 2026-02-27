# OpenClaw 记忆机制深度解析：设计原理与核心问题

本文档基于 OpenClaw 记忆系统的对话整理，深入探讨其设计哲学、持久化机制及防丢失策略。

## 一、核心设计原理：内存（Context） vs 磁盘（Storage）

OpenClaw 的记忆系统建立在一个核心假设之上：**只有写进文件的，才是真的。**

| 特性         | 内存 (Context)                          | 磁盘 (Storage)                             |
| :----------- | :-------------------------------------- | :----------------------------------------- |
| **存在形式** | LLM 的 Prompt (输入框里的文字)          | Markdown 文件 (`MEMORY.md`, `memory/*.md`) |
| **生命周期** | 短暂，随会话压缩而消失                  | 永久，除非手动删除                         |
| **容量**     | 小且昂贵 (128k - 200k tokens)           | 无限且廉价 (GB/TB)                         |
| **检索方式** | 被动 (Attention 机制)                   | 主动 (Vector/Keyword Search)               |
| **比喻**     | **大脑的工作记忆** (刚才听到的电话号码) | **写在纸上的笔记** (电话簿)                |

Context 是**思考的过程**，Storage 是**思考的结论**。智能体的高级能力，体现为主动将"过程"沉淀为"结论"的能力。

## 二、关键机制问答（Q&A）

### Q1: 记忆的持久性与生命周期

**问**：如果模型在当前的上下文中"记住"了用户的偏好，但直到会话触发自动压缩（Compaction）时仍未写入文件，这段记忆会怎样？
**答**：**会彻底丢失。**
在 OpenClaw 中，**压缩 = 遗忘**。压缩本质是截断或摘要当前上下文窗口。如果信息仅存在于内存中，一旦压缩发生，它就会消失。
因此，系统设计了 **"静默回合"（Silent Turn/Memory Flush）**：在压缩**之前**强制插入一个回合，提醒模型将重要信息写入磁盘。这是记忆持久化的关键时刻。

### Q2: 双层存储架构的设计意图

**问**：为什么区分 `memory/YYYY-MM-DD.md`（每日日志）和 `MEMORY.md`（长期记忆）？
**答**：为了平衡 **信噪比** 和 **检索效率**。

- `memory/YYYY-MM-DD.md` 是**流水账**（高噪声），记录操作历史，用于恢复上下文背景。
- `MEMORY.md` 是**精华**（高信号），记录决策和规则。
- 如果所有信息都混在一起，向量搜索的准确率会下降（Top-K 问题），导致检索到大量无关噪音。

### Q3: 混合搜索（Hybrid Search）的必要性

**问**：为什么默认启用向量（Vector）+ BM25（关键词）混合搜索？
**答**：为了解决单一检索方式的盲点：

- **纯向量失效场景**：搜索精确字符串（如错误码 `ERR_9283`、Git Hash）。向量懂语义但对精确字符不敏感。
- **纯 BM25 失效场景**：搜索意图（如"避免频繁索引" vs 文档中的 "debounce"）。字面完全不同，关键词匹配无效。
  混合搜索结合了语义理解和精确匹配的优势。

### Q4: 压缩必然导致信息丢失，OpenClaw 如何规避关键信息丢失？

**问**：压缩是有损操作，如何保证关键信息不丢？
**答**：OpenClaw 设置了 **三道防线**：

1.  **静默的"临终遗言"（Memory Flush）**：在压缩**前**暂停对话，强制提取重要信息写入磁盘。这是防丢失的第一道也是最重要防线。
2.  **每日日志的"流水账"（Daily Logs）**：重启或压缩后，自动加载今天和昨天的日志。即使短期内存清空，最近的操作背景会被恢复。
3.  **滑动窗口保留（Sliding Window）**：压缩通常是截断旧的、保留新的（如保留最近 15k tokens）。当前正在讨论的话题通常是安全的。

### Q5: 还有哪些隐性防线保证记忆完整性？

**问**：除了上述机制，还有哪些兜底策略？
**答**：

1.  **全量会话索引（Session Memory，实验性）**：系统可索引所有原始聊天记录（`sessions/*.jsonl`）。即使忘了写总结，只要说过的话都能通过搜索找回。这是最后的"后悔药"。
2.  **引导文件注入（Bootstrap Injection）**：启动时将核心文件（`MEMORY.md`, `BOOTSTRAP.md`）直接拼接到 System Prompt。这些核心记忆常驻内存，无需搜索。
3.  **主动召回指令（System Prompt）**：硬编码指令强制智能体在回答"过去"的问题前必须先查数据库，减少幻觉。
4.  **人机共建（File Watcher）**：用户可以直接编辑 `MEMORY.md`。文件监听器会实时感知修改并触发重索引，实现"上帝视角"的记忆修正。

## 三、长期任务（Long-running Task）的挑战与解决方案

**Q6: 现有的记忆机制能否支持执行 1-2 天甚至更长的无人值守任务？**
**答**：仅靠 Memory 机制**不够健壮**，容易迷失。

### 问题分析：记忆 vs 状态

长期任务不仅需要"记住事实"（Knowledge），更需要"管理状态"（State）。

| 维度         | Memory (记忆)             | Task/State (状态)                  |
| :----------- | :------------------------ | :--------------------------------- |
| **关注点**   | 知识、决策、偏好          | 进度、待办、当前步骤               |
| **典型问题** | "Redis 的密码是多少？"    | "重构任务现在进行到第几个文件了？" |
| **存储载体** | `MEMORY.md` (非结构化)    | `TODO.md` / `Task Tool` (结构化)   |
| **丢失后果** | 不知道怎么做 (查文档即可) | 不知道做到哪了 (任务崩溃/重复执行) |

### 解决方案：左右脑协同

为了支持超长任务，必须结合以下机制：

1.  **结构化任务栈（Todo System）**
    - 强制使用 `TodoWrite` 工具。
    - System Prompt 会优先读取 Todo List。即使对话被压缩，Todo List 依然保留当前进度指针（如 `[IN_PROGRESS] Step 3/5`）。

2.  **每日日志检查点（Daily Checkpoints）**
    - 要求智能体每完成一个子任务，强制写入 `memory/YYYY-MM-DD.md`。
    - 作用：作为崩溃重启后的恢复锚点（Anchor）。

3.  **外部状态文件（External State）**
    - 对于极复杂任务（如爬虫），维护专用的 `progress.json`。

**结论**：长期任务 = **Memory**（知识库）+ **Todo**（状态机）。缺一不可。

## 四、工程落地中的"隐形"关键点

在实际落地 OpenClaw 记忆系统时，除了上述机制，还有几个极易被忽视但至关重要的工程细节：

### Q7: 多智能体（Multi-Agent）如何实现信息交互？

**问**：OpenClaw 支持智能体之间的直接通信（如心灵感应）吗？
**答**：**不支持**。OpenClaw 采用**强隔离（Isolation-First）**架构。

- **现状**：每个智能体拥有独立的 Workspace、AgentDir 和 Session。Agent A 无法直接读取 Agent B 的 `MEMORY.md`。
- **工程解法**：
  1.  **文件系统中转（Shared File System）**：最常用的解法。Agent A 将结果写入共享目录（如 `/shared/status.md`），Agent B 配置 `memorySearch.extraPaths` 读取该目录。**文件系统即通信协议。**
  2.  **OpenProse 编排**：使用 `session` 原语实现父子层级的任务分发与结果回收（Context Binding）。

### Q8: 记忆的"时效性"与"冲突解决"（Data Consistency）

**问**：如果 `MEMORY.md` 里同时存在"使用 Vue 2"（旧记忆）和"使用 Vue 3"（新记忆），智能体听谁的？
**答**：这是一个经典的**RAG 冲突问题**。

- **风险**：向量搜索可能同时召回新旧两条规则，导致模型困惑（Hallucination）。
- **工程解法**：
  1.  **显式的时间戳**：要求智能体写入记忆时带上日期（`2023-10: Migrate to Vue 3`）。LLM 对时间敏感，能判断先后。
  2.  **定期修剪（Gardening）**：记忆不是"只增不减"的。必须安排人工或脚本定期清理 `MEMORY.md` 中的过时信息，否则"记忆垃圾"会淹没有效信息。

### Q9: 向量搜索的"语义漂移"（Semantic Drift）

**问**：随着项目演进，同一个词（如 `Auth`）的含义变了怎么办？
**答**：

- **现象**：早期 `Auth` 指的是 Basic Auth，后期指的是 OAuth2。旧的记忆块可能会误导新的查询。
- **工程解法**：
  - **上下文消歧**：在写入记忆时，不要只写"Auth 很慢"，要写"2024年 Q1 的 Basic Auth 模块响应很慢"。**完整的上下文比简短的结论更重要。**

## 五、记忆检索全流程详解 (The Retrieval Lifecycle)

本节通过一个具体示例，详细拆解 OpenClaw 从用户提问到记忆召回的完整执行链路。

### 示例场景

- **用户提问**："上次我们决定的 Redis 密码是什么？"
- **前提**：
  - `MEMORY.md`：`Redis password for dev is 's3cr3t_pass'.`
  - `memory/2024-02-27.md`：`今天调试了 Redis 连接问题。`
  - `sessions/chat-123.jsonl` (Beta)：原始对话记录。

### 0. 启动阶段：隐式上下文加载 (Bootstrap Phase)

**这是用户提问前就已经发生的步骤。**

- **Step 0.1: 读取每日日志**
  - 会话启动时，系统自动读取 `memory/2024-02-27.md`（今天）和 `memory/2024-02-26.md`（昨天）。
  - 这些内容被直接拼接到 Context 中。
  - **作用**：如果答案就在这两天的日志里，LLM 可能**直接回答**，根本不需要调用 `memory_search`。

### 1. 意图识别与工具调用 (Intent & Tool Call)

- **Step 1.1: System Prompt 触发**
  - 如果上下文（包括每日日志）里没有答案，LLM 决定查阅更久远的记忆。
  - System Prompt 指令：`"Before answering... run memory_search"`。
- **Step 1.2: 生成工具调用**
  - **Call**: `memory_search("Redis password")`

### 2. 混合多源检索执行 (Hybrid Multi-Source Search)

OpenClaw 后端接收到工具调用，**并行扫描所有配置的数据源**：

- **数据源 A: 核心记忆** (`MEMORY.md`) -> 权重最高
- **数据源 B: 历史日志** (`memory/*.md`) -> 权重中等
- **数据源 C: 原始会话** (`sessions/*.jsonl`) -> **(Beta, 需开启)** 权重较低

对于每个启用的源，同时执行向量（Vector）和关键词（BM25）搜索。

#### A 路：向量搜索 (Vector Search)

- **Step 2A.1: Query Embedding**
  - 将 "Redis password" 转为向量。
- **Step 2A.2: Vector Similarity**
  - 在 SQLite (`vec0`) 中计算与所有源（Memory + Daily + Session）的相似度。

#### B 路：关键词搜索 (Keyword Search)

- **Step 2B.1: BM25/FTS5**
  - 在 SQLite (`fts`) 中检索所有源的文本。

### 3. 结果融合与重排序 (Fusion & Reranking)

- **Step 3.1: 归一化与加权**
  - 将两路分数归一化到 0-1 区间。
  - 应用配置权重（默认 `vectorWeight: 0.7`, `textWeight: 0.3`）。
  - `FinalScore = 0.7 * VectorScore + 0.3 * BM25Score`
- **Step 3.2: 候选截断**
  - 取前 N 个结果（Top-K，默认 5-10 个）。
  - **Result**: 召回了包含 `Redis password for dev is 's3cr3t_pass'.` 的片段。

### 4. 结果返回与上下文注入 (Context Injection)

- **Step 4.1: 工具输出**
  - 工具返回 JSON 结果给 LLM：
  ```json
  [
    {
      "content": "...Redis password for dev is 's3cr3t_pass'...",
      "source": "MEMORY.md",
      "score": 0.89
    }
  ]
  ```
- **Step 4.2: LLM 思考**
  - LLM 阅读工具返回的片段。
  - 确认找到了答案。

### 5. 最终回答 (Final Response)

- **Step 5.1: 生成回复**
  - LLM 回复用户："根据记忆，开发环境的 Redis 密码是 `s3cr3t_pass`。"

### Q10: 每日日志文件（Daily Log）如果过大会撑爆 Context 吗？

**问**：默认加载昨天和今天的日志，如果文件很大（如 50MB），会不会导致 Token 溢出？
**答**：**不会，有硬性截断保护。**

- **截断机制**：`agents.defaults.bootstrapMaxChars`（默认 20k 字符）和 `bootstrapTotalMaxChars`（默认 150k 字符）是硬性上限。
- **行为**：
  1.  系统读取文件时，如果超限，会自动保留最新的 N 个字符。
  2.  插入标记：`[...truncated, read memory/YYYY-MM-DD.md for full content...]`。
  3.  **智能体行为**：看到截断标记后，如果觉得缺失了关键信息，智能体会主动调用 `memory_get` 工具读取剩余部分。
- **结论**：只会丢失信息（需工具召回），不会导致程序崩溃。

### Q11: 向量嵌入（Embedding）的技术实现细节是怎样的？

**问**：OpenClaw 是如何将 Markdown 变成向量存入 SQLite 的？
**答**：采用 **Local-First, Cloud-Fallback** 的混合流水线：

1.  **切片（Chunking）**：按段落/标题切分，约 400 tokens/块，80 tokens 重叠。
2.  **哈希与缓存（Hashing & Cache）**：计算切片 Hash，先查 `embedding_cache` 表。命中缓存则跳过计算（极大节省成本）。
3.  **计算嵌入（Embedding Provider）**：
    - **优先本地**：如果有 `node-llama-cpp` + 本地模型（GGUF），在本地 CPU/GPU 跑（隐私、免费）。
    - **回退云端**：否则调用 OpenAI/Gemini API（支持 Batch API 以降低成本）。
4.  **存储（Storage）**：向量存入 SQLite `vec0` 虚拟表（需 `sqlite-vec` 扩展）或 Blob 字段。
5.  **检索（Retrieval）**：计算 Query 向量与存储向量的余弦相似度。

---

_整理自 OpenClaw 记忆机制深度对话_
