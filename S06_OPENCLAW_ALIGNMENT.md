# S06 Memory System - OpenClaw 对应关系

## 概述

优化后的 `s06_mem.py` 现在正确地实现了原始 OpenClaw 的 Memory 和 Soul 系统设计。本文档说明 s06_mem.py 如何与原始 OpenClaw 的架构对应。

## Memory 工具设计

### 原始 OpenClaw 的设计

在原始 OpenClaw 中，内存管理采用**读工具 + 文件直接编辑**的模式：

```
┌─ Agent ─────────────────────────────┐
│                                     │
│  memory_search(query)               │
│  ↓                                  │
│  [Semantic search MEMORY.md + daily]│
│  ↓                                  │
│  Returns: [{path, snippet, score}]  │
│                                     │
│  memory_get(path, from, lines)      │
│  ↓                                  │
│  [Read specific file/lines]         │
│  ↓                                  │
│  Returns: {path, text}              │
│                                     │
│  bash tool (direct edit)            │
│  ↓                                  │
│  Edit MEMORY.md / memory/*.md       │
│  ↓                                  │
│  Persist to disk                    │
└─────────────────────────────────────┘
```

**关键点**：
- `memory_search` - 语义搜索工具（通过 LLM embeddings）
- `memory_get` - 精确读工具（通过文件系统）
- **没有 `memory_write` 工具** - 写入通过 bash/文件编辑工具完成
- 内存文件是**源文件**，Agent 通过工具直接访问磁盘

### S06 的简化教学设计

s06_mem.py 保留了原始设计的核心，但为了教学目的做了两个简化：

```
┌─ Agent ─────────────────────────────┐
│                                     │
│  memory_search(query, top_k)        │
│  ↓                                  │
│  [TF-IDF search MEMORY.md + daily]  │
│  ↓                                  │
│  Returns: [{path, snippet, score}]  │
│                                     │
│  memory_get(path, from, lines)      │
│  ↓                                  │
│  [Read specific file/lines]         │
│  ↓                                  │
│  Returns: {path, text, lines}       │
│                                     │
│  memory_write(content, category)    │ ← 教学简化
│  ↓                                  │
│  [Write to daily log]               │
│  ↓                                  │
│  Persist to disk                    │
└─────────────────────────────────────┘
```

**简化点**：
1. 使用 **TF-IDF + 余弦相似度** 替代 LLM embeddings
   - 避免外部 API 依赖
   - 教学上更易理解搜索原理
   - 但向量质量不如真实 embeddings

2. 提供 **`memory_write` 工具** 作为教学便利
   - 原始 OpenClaw 需要 Agent 通过 bash 编辑文件
   - s06 提供快捷工具，让 Agent 更容易理解内存写入
   - 生产环境可以用 bash 工具替代

## 关键设计对应

| 功能 | 原始 OpenClaw | S06 实现 |
|------|----------------|---------|
| **memory_search** | LLM embeddings (openai/gemini/local) | TF-IDF + cosine similarity |
| **搜索范围** | MEMORY.md + memory/*.md + 可选 session | MEMORY.md + memory/*.md |
| **搜索结果** | path, startLine, endLine, snippet, score | path, line_start, line_end, snippet, score |
| **memory_get** | 精确读，支持 from/lines | 精确读，支持 from/lines |
| **写入方式** | bash 工具编辑文件 | memory_write 工具（教学） |
| **搜索隔离** | 支持 scope（DM vs groups）| 暂无（可扩展） |
| **Vector索引** | sqlite-vec 加速 | 无索引（线性搜索） |
| **后端切换** | 支持 QMD 等多后端 | TF-IDF only |

## System Prompt 的对应

### 原始 OpenClaw 的内存提示

```
## Memory Recall

Before answering anything about prior work, decisions, dates, people,
preferences, or todos: run memory_search on MEMORY.md + memory/*.md;
then use memory_get to pull only the needed lines. If low confidence
after search, say you checked.
```

### S06 的扩展提示

```
## Memory Recall (Mandatory Step)

Before answering anything about prior work, decisions, dates, people,
preferences, or todos:
1. Call memory_search to semantically query MEMORY.md + memory/*.md
2. Use memory_get to read specific lines if you need more context
3. If low confidence after search, tell the user you checked memory
4. To update permanent facts, edit MEMORY.md via bash tool
5. To log today's context, use memory_write or bash to append to
   memory/YYYY-MM-DD.md
```

**改进**：更明确地指导 Agent 如何使用三个内存工具。

## Memory 文件结构

S06 保留了原始 OpenClaw 的文件组织：

```
workspace/
  {agent_id}_SOUL.md           ← Agent 的人格定义
  {agent_id}_MEMORY.md         ← Agent 的永久记忆
  {agent_id}_memory/           ← Agent 的每日日志
    2026-02-28.md
    2026-02-27.md
    2026-02-26.md
    ...
```

对应原始 OpenClaw 的全局结构：

```
~/.openclaw/workspace/
  SOUL.md                      ← Global soul (s06: per-agent)
  MEMORY.md                    ← Global memory (s06: per-agent)
  memory/
    2026-02-28.md
    2026-02-27.md
    ...
```

**改进**：S06 支持多 Agent，每个 Agent 独立的 SOUL + MEMORY，而原始 OpenClaw（单 Agent）使用全局文件。

## 内存搜索的工作流

### 原始 OpenClaw

```
1. Agent 接收用户消息
2. System Prompt 提醒：如果问题涉及先前信息，先调用 memory_search
3. memory_search(query)
   ↓
   - 加载 MEMORY.md 和 memory/*.md
   - 将文本分块（~400 tokens per chunk）
   - 计算 embeddings（调用嵌入 API）
   - 与查询进行向量相似度搜索
   - 返回 top-k results
4. Agent 可选调用 memory_get(path, from, lines) 读取完整上下文
5. Agent 基于记忆信息回答
6. 对话记录存储（session 日志）
```

### S06 的简化流程

```
1. Agent 接收用户消息
2. System Prompt 提醒：如果问题涉及先前信息，先调用 memory_search
3. memory_search(query)
   ↓
   - 加载 MEMORY.md 和 memory/*.md
   - 将文本分块（按 markdown heading）
   - 计算 TF-IDF 向量（本地计算）
   - 与查询进行余弦相似度搜索
   - 返回 top-k results (score > 0.01)
4. Agent 可选调用 memory_get(path, from, lines) 读取完整上下文
5. Agent 基于记忆信息回答
6. 对话记录存储（session 日志）
```

## 搜索质量对比

### TF-IDF（S06）的优缺点

✅ **优势**：
- 完全本地计算，无 API 调用
- 性能快（线性搜索）
- 易于理解和调试
- 对关键词和技术术语敏感

❌ **劣势**：
- 对语义变化敏感（"debounce file updates" vs "avoid frequent indexing"）
- 无法处理多语言
- 对拼写错误敏感

### Embeddings（原始 OpenClaw）的优缺点

✅ **优势**：
- 语义理解强（"this means the same" detection）
- 对表述变化不敏感
- 多语言支持
- 容错性更好

❌ **劣势**：
- 依赖外部 API
- 成本（embedding API 调用）
- 隐私问题（数据上传）

## 向生产迁移

如果要将 S06 升级到生产级 OpenClaw 内存系统，需要：

1. **Replace search backend**：
   ```python
   # 从 TF-IDF 改为 embeddings
   from openai import OpenAI
   client = OpenAI()

   embedding = client.embeddings.create(
       model="text-embedding-3-small",
       input=text
   )
   ```

2. **Add vector storage**：
   ```python
   # 从内存搜索改为 sqlite-vec
   import sqlite_vec
   db = sqlite3.connect("memory.db")
   db.enable_load_extension("sqlite_vec")
   ```

3. **Add session memory indexing**：
   - 可选索引 session 日志（对话记录）
   - 让 Agent 搜索过去的对话内容

4. **Replace memory_write**：
   - 移除 memory_write 工具
   - 让 Agent 使用 bash 工具直接编辑文件
   - 增加 memory 编辑权限控制

5. **Add search scope control**：
   - 可在 DM 中搜索所有内存
   - 在 group/channel 中只搜索非隐私内存

## 与 S05 网关的集成

S06 可以完全集成到 S05 的多 Agent 网关中：

```
WebSocket Client
    ↓
RoutingGateway (s05)
    ↓ resolve(channel, sender, ...)
MessageRouter
    ↓
AgentWithSoulMemory (s06)
    ├─ Load SOUL.md
    ├─ Build System Prompt (soul + base + memory)
    └─ Execute with tools
         ├─ memory_search
         ├─ memory_get
         ├─ memory_write
         └─ s04 tools
    ↓
LLM Response
    ↓
SessionStore (persisted)
```

**Flow**：
1. 消息路由到对应 Agent
2. Agent 加载自己的 Soul 和 Memory
3. 构建融合 Soul + Memory 的 system prompt
4. 调用 LLM 并提供内存工具
5. 持久化会话历史

## 测试内存系统

### 基础测试（REPL 模式）

```bash
python s06_mem.py --repl
```

**测试场景**：

1. **内存写入和搜索**：
   ```
   You > 我叫小张，工作在 OpenClaw 项目
   [Agent 自动调用 memory_write，记忆用户信息]

   You > 你知道我是谁吗？
   [Agent 调用 memory_search("user name")，找到记忆]
   Assistant > 你是小张，工作在 OpenClaw 项目...
   ```

2. **精确读取**：
   ```
   You > 请从我的记忆中读取关于 OpenClaw 的内容
   [Agent 调用 memory_search("OpenClaw")]
   [Agent 调用 memory_get(path, from, lines)]
   Assistant > 根据你的记忆...
   ```

3. **多会话隔离**：
   ```
   Session A: 我喜欢 Rust
   Session B: 我喜欢 Go

   [两个会话的记忆完全隔离，由 session_key 管理]
   ```

## 故障排查

### 内存搜索返回空结果

**可能原因**：
1. MEMORY.md 或 memory/*.md 文件不存在
2. 搜索词与记忆内容无匹配
3. TF-IDF 阈值过高（score > 0.01）

**解决**：
```python
# 调整阈值
results = store.search_memory(query, top_k=10)
# 检查分值
for r in results:
    print(f"{r['path']}: {r['score']}")
```

### 内存文件写入失败

**可能原因**：
1. `agent_id_memory/` 目录不存在
2. 文件系统权限不足
3. 磁盘满

**解决**：
```bash
# 确保目录存在
mkdir -p workspace/{agent_id}_memory
# 检查权限
ls -la workspace/
```

## 总结

S06 Memory System 是对原始 OpenClaw 设计的**忠实教学实现**：

✅ **完整继承**：
- 双层记忆架构（MEMORY.md + daily logs）
- 三工具模式（memory_search + memory_get + write）
- System Prompt 强制内存回忆步骤
- Agent 级隔离（每个 Agent 独立内存）

✅ **教学简化**：
- TF-IDF 替代 embeddings（无外部 API）
- memory_write 工具替代 bash 编辑（更易学）
- 线性搜索替代 vector indexing（性能不是重点）

✅ **可升级设计**：
- 易于集成真实 embeddings
- 易于添加 vector 存储
- 易于支持多 Agent 和 session 路由

这使 S06 成为学习 OpenClaw 内存系统的完美入门，同时保持生产就绪的架构基础。
