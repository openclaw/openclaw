---
read_when:
  - 设计超越每日 Markdown 日志的工作区记忆（~/.openclaw/workspace）
  - Deciding: standalone CLI vs deep OpenClaw integration
  - 添加离线回忆 + 反思（retain/recall/reflect）
summary: 研究笔记：Clawd 工作区的离线记忆系统（Markdown 作为数据源 + 派生索引）
title: 工作区记忆研究
x-i18n:
  generated_at: "2026-02-03T10:06:14Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 1753c8ee6284999fab4a94ff5fae7421c85233699c9d3088453d0c2133ac0feb
  source_path: experiments/research/memory.md
  workflow: 15
---

# 工作区记忆 v2（离线）：研究笔记

目标：Clawd 风格的工作区（`agents.defaults.workspace`，默认 `~/.openclaw/workspace`），其中"记忆"以每天一个 Markdown 文件（`memory/YYYY-MM-DD.md`）加上一小组稳定文件（例如 `memory.md`、`SOUL.md`）的形式存储。

本文档提出一种**离线优先**的记忆架构，保持 Markdown 作为规范的、可审查的数据源，但通过派生索引添加**结构化回忆**（搜索、实体摘要、置信度更新）。

## 为什么要改变？

当前设置（每天一个文件）非常适合：

- "仅追加"式日志记录
- 人工编辑
- git 支持的持久性 + 可审计性
- 低摩擦捕获（"直接写下来"）

但它在以下方面较弱：

- 高召回率检索（"我们对 X 做了什么决定？"、"上次我们尝试 Y 时？"）
- 以实体为中心的答案（"告诉我关于 Alice / The Castle / warelay 的信息"）而无需重读多个文件
- 观点/偏好稳定性（以及变化时的证据）
- 时间约束（"2025 年 11 月期间什么是真实的？"）和冲突解决

## 设计目标

- **离线**：无需网络即可工作；可在笔记本电脑/Castle 上运行；无云依赖。
- **可解释**：检索的项目应该可归因（文件 + 位置）并与推理分离。
- **低仪式感**：每日日志保持 Markdown，无需繁重的 schema 工作。
- **增量式**：v1 仅使用 FTS 就很有用；语义/向量和图是可选升级。
- **对智能体友好**：使"在 token 预算内回忆"变得简单（返回小型事实包）。

## 北极星模型（Hindsight × Letta）

需要融合两个部分：

1. **Letta/MemGPT 风格的控制循环**

- 保持一个小的"核心"始终在上下文中（角色 + 关键用户事实）
- 其他所有内容都在上下文之外，通过工具检索
- 记忆写入是显式的工具调用（append/replace/insert），持久化后在下一轮重新注入

2. **Hindsight 风格的记忆基底**

- 分离观察到的、相信的和总结的内容
- 支持 retain/recall/reflect
- 带有置信度的观点可以随证据演变
- 实体感知检索 + 时间查询（即使没有完整的知识图谱）

## 提议的架构（Markdown 数据源 + 派生索引）

### 规范存储（git 友好）

保持 `~/.openclaw/workspace` 作为规范的人类可读记忆。

建议的工作区布局：

```
~/.openclaw/workspace/
  memory.md                    # 小型：持久事实 + 偏好（类似核心）
  memory/
    YYYY-MM-DD.md              # 每日日志（追加；叙事）
  bank/                        # "类型化"记忆页面（稳定、可审查）
    world.md                   # 关于世界的客观事实
    experience.md              # 智能体做了什么（第一人称）
    opinions.md                # 主观偏好/判断 + 置信度 + 证据指针
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

注意：

- **每日日志保持为每日日志**。无需将其转换为 JSON。
- `bank/` 文件是**经过整理的**，由反思任务生成，仍可手动编辑。
- `memory.md` 保持"小型 + 类似核心"：你希望 Clawd 每次会话都能看到的内容。

### 派生存储（机器回忆）

在工作区下添加派生索引（不一定需要 git 跟踪）：

```
~/.openclaw/workspace/.memory/index.sqlite
```

后端支持：

- 用于事实 + 实体链接 + 观点元数据的 SQLite schema
- SQLite **FTS5** 用于词法回忆（快速、小巧、离线）
- 可选的嵌入表用于语义回忆（仍然离线）

索引始终**可从 Markdown 重建**。

## Retain / Recall / Reflect（操作循环）

### Retain：将每日日志规范化为"事实"

Hindsight 在这里重要的关键洞察：存储**叙事性、自包含的事实**，而不是微小的片段。

`memory/YYYY-MM-DD.md` 的实用规则：

- 在一天结束时（或期间），添加一个 `## Retain` 部分，包含 2-5 个要点：
  - 叙事性（保留跨轮上下文）
  - 自包含（独立时也有意义）
  - 标记类型 + 实体提及

示例：

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy's birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

最小化解析：

- 类型前缀：`W`（世界）、`B`（经历/传记）、`O`（观点）、`S`（观察/摘要；通常是生成的）
- 实体：`@Peter`、`@warelay` 等（slug 映射到 `bank/entities/*.md`）
- 观点置信度：`O(c=0.0..1.0)` 可选

如果你不想让作者考虑这些：反思任务可以从日志的其余部分推断这些要点，但有一个显式的 `## Retain` 部分是最简单的"质量杠杆"。

### Recall：对派生索引的查询

Recall 应支持：

- **词法**："查找精确的术语/名称/命令"（FTS5）
- **实体**："告诉我关于 X 的信息"（实体页面 + 实体链接的事实）
- **时间**："11 月 27 日前后发生了什么"/"自上周以来"
- **观点**："Peter 偏好什么？"（带置信度 + 证据）

返回格式应对智能体友好并引用来源：

- `kind`（`world|experience|opinion|observation`）
- `timestamp`（来源日期，或如果存在则提取的时间范围）
- `entities`（`["Peter","warelay"]`）
- `content`（叙事性事实）
- `source`（`memory/2025-11-27.md#L12` 等）

### Reflect：生成稳定页面 + 更新信念

反思是一个定时任务（每日或心跳 `ultrathink`），它：

- 根据最近的事实更新 `bank/entities/*.md`（实体摘要）
- 根据强化/矛盾更新 `bank/opinions.md` 置信度
- 可选地提议对 `memory.md`（"类似核心"的持久事实）的编辑

观点演变（简单、可解释）：

- 每个观点有：
  - 陈述
  - 置信度 `c ∈ [0,1]`
  - last_updated
  - 证据链接（支持 + 矛盾的事实 ID）
- 当新事实到达时：
  - 通过实体重叠 + 相似性找到候选观点（先 FTS，后嵌入）
  - 通过小幅增量更新置信度；大幅跳跃需要强矛盾 + 重复证据

## CLI 集成：独立 vs 深度集成

建议：**深度集成到 OpenClaw**，但保持可分离的核心库。

### 为什么要集成到 OpenClaw？

- OpenClaw 已经知道：
  - 工作区路径（`agents.defaults.workspace`）
  - 会话模型 + 心跳
  - 日志记录 + 故障排除模式
- 你希望智能体自己调用工具：
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### 为什么仍要分离库？

- 保持记忆逻辑可测试，无需 Gateway 网关/运行时
- 可从其他上下文重用（本地脚本、未来的桌面应用等）

形态：
记忆工具预计是一个小型 CLI + 库层，但这仅是探索性的。

## "S-Collide" / SuCo：何时使用（研究）

如果"S-Collide"指的是 **SuCo（Subspace Collision）**：这是一种 ANN 检索方法，通过在子空间中使用学习/结构化碰撞来实现强召回/延迟权衡（论文：arXiv 2411.14754，2024）。

对于 `~/.openclaw/workspace` 的务实观点：

- **不要从** SuCo 开始。
- 从 SQLite FTS +（可选的）简单嵌入开始；你会立即获得大部分 UX 收益。
- 仅在以下情况下考虑 SuCo/HNSW/ScaNN 级别的解决方案：
  - 语料库很大（数万/数十万个块）
  - 暴力嵌入搜索变得太慢
  - 召回质量明显受到词法搜索的瓶颈限制

离线友好的替代方案（按复杂性递增）：

- SQLite FTS5 + 元数据过滤（零 ML）
- 嵌入 + 暴力搜索（如果块数量低，效果出奇地好）
- HNSW 索引（常见、稳健；需要库绑定）
- SuCo（研究级；如果有可嵌入的可靠实现则很有吸引力）

开放问题：

- 对于你的机器（笔记本 + 台式机）上的"个人助理记忆"，**最佳**的离线嵌入模型是什么？
  - 如果你已经有 Ollama：使用本地模型嵌入；否则在工具链中附带一个小型嵌入模型。

## 最小可用试点

如果你想要一个最小但仍有用的版本：

- 添加 `bank/` 实体页面和每日日志中的 `## Retain` 部分。
- 使用 SQLite FTS 进行带引用的回忆（路径 + 行号）。
- 仅在召回质量或规模需要时添加嵌入。

## 参考资料

- Letta / MemGPT 概念："核心记忆块" + "档案记忆" + 工具驱动的自编辑记忆。
- Hindsight 技术报告："retain / recall / reflect"，四网络记忆，叙事性事实提取，观点置信度演变。
- SuCo：arXiv 2411.14754（2024）："Subspace Collision"近似最近邻检索。
