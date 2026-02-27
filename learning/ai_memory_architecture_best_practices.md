# AI Agent 记忆系统设计：工程落地最佳实践准则 (Based on OpenClaw)

本文档提炼自 OpenClaw 的记忆系统设计理念，旨在为构建稳定、可扩展的 AI Agent 系统提供通用的架构蓝图与工程准则。

## 一、核心哲学：信噪分离与持久化

### 1. "写在磁盘上的才是真的" (Disk is Truth)

- **原则**：不要信任 LLM 的 Context Window。Context 是易失的内存，文件系统（或数据库）才是持久的硬盘。
- **实践**：系统必须提供显式的工具（如 `write_memory`），并强制要求 Agent 将决策、用户偏好和长期计划写入持久化存储。
- **反模式**：依赖 Agent 在超长对话中"记住"一开始的设定，而不进行持久化。

### 2. 双层存储架构 (Tiered Storage)

- **原则**：将"事实"与"历史"分离。
- **架构**：
  - **Tier 1: 精华区 (Curated Memory)**
    - **内容**：决策结论、用户偏好、核心规则。
    - **特点**：高信噪比，常驻或高频检索。
    - **载体**：`MEMORY.md` 或结构化数据库表。
  - **Tier 2: 流水区 (Daily Logs / Audit Trails)**
    - **内容**：操作日志、调试过程、对话原声。
    - **特点**：低信噪比，仅用于回溯或上下文恢复。
    - **载体**：`logs/YYYY-MM-DD.md` 或日志流。

## 二、检索增强：混合与兜底

### 3. 混合搜索 (Hybrid Search)

- **原则**：不要单押向量搜索。
- **实践**：
  - **向量 (Vector)**：解决"语义相关"（搜意图）。
  - **关键词 (BM25/FTS)**：解决"精确匹配"（搜 ID、错误码、特定术语）。
- **公式**：`Final Score = α * VectorScore + (1-α) * KeywordScore`

### 4. 引导注入 (Bootstrap Injection)

- **原则**：核心规则不应依赖概率性的搜索。
- **实践**：将最关键的身份定义、核心任务指令（如 `BOOTSTRAP.md`）直接拼接到 System Prompt 中。
- **比喻**：搜索是"翻书"，注入是"刻在脑子里"。

## 三、稳定性设计：防丢失与状态管理

### 5. 静默保存机制 (Silent Flush)

- **原则**：在遗忘发生前，必须有最后一次保存机会。
- **实践**：在 Context Window 即将溢出或会话结束前，系统**强制插入**一个静默回合（User 不可见），提示 Agent："快要遗忘了，请总结并保存重要信息。"

### 6. 左右脑协同 (Memory vs State)

- **原则**：长期任务不能只靠记忆（Memory），必须靠状态（State）。
- **架构**：
  - **右脑 (Memory)**：非结构化文本，存知识。
  - **左脑 (State)**：结构化数据（Todo List, JSON），存进度。
- **实践**：对于长任务，强制 Agent 维护 `TODO.md` 或 `progress.json`。崩溃重启时，优先读取状态文件恢复进度指针。

## 四、工程演进：维护与交互

### 7. 上下文消歧 (Context Disambiguation)

- **原则**：写入记忆时，必须包含时间与环境上下文。
- **实践**：
  - ❌ 错误：`"Auth 模块很慢"`
  - ✅ 正确：`"2024-02: Basic Auth 模块响应慢，计划迁移到 OAuth2"`
- **目的**：防止语义漂移（Semantic Drift）导致的检索误导。

### 8. 文件系统即通信协议 (Filesystem as Protocol)

- **原则**：多 Agent 协作应解耦，避免复杂的 P2P 消息总线。
- **实践**：Agent A 写文件，Agent B 读文件（通过监听或轮询）。
- **优势**：天然的持久化、可审计、易调试。

### 9. 人机共建 (Human-in-the-Loop)

- **原则**：AI 的记忆应是对人类可见且可编辑的。
- **实践**：记忆文件应为纯文本（Markdown/JSON）。允许人类手动修正 AI 的错误记忆，系统应实时感知文件变更并重建索引。

---

_Generated for System Architecture Reference_
