---
read_when:
  - 设计超越每日 Markdown 日志的工作区记忆（~/.openclaw/workspace）
  - 决策：独立 CLI 还是深度集成 OpenClaw
  - 添加离线召回 + 反思（retain/recall/reflect）
summary: 研究笔记：Clawd 工作区离线记忆系统（Markdown 作为事实来源 + 派生索引）
title: 工作区记忆研究
x-i18n:
  generated_at: "2026-02-01T20:25:43Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 1753c8ee6284999fab4a94ff5fae7421c85233699c9d3088453d0c2133ac0feb
  source_path: experiments/research/memory.md
  workflow: 14
---

# 工作区记忆 v2（离线）：研究笔记

目标：Clawd 风格的工作区（`agents.defaults.workspace`，默认 `~/.openclaw/workspace`），其中"记忆"以每日一个 Markdown 文件（`memory/YYYY-MM-DD.md`）加上一小组稳定文件（如 `memory.md`、`SOUL.md`）的形式存储。

本文档提出一种**离线优先**的记忆架构，保持 Markdown 作为规范的、可审查的事实来源，同时通过派生索引添加**结构化召回**（搜索、实体摘要、置信度更新）。

## 为什么要改变？

当前方案（每日一个文件）非常适合：

- "仅追加"的日志记录
- 人工编辑
- git 支持的持久性 + 可审计性
- 低摩擦的信息捕获（"直接写下来就好"）

但在以下方面表现较弱：

- 高召回率检索（"我们对 X 做了什么决定？"、"上次我们尝试 Y 是什么时候？"）
- 以实体为中心的回答（"告诉我关于 Alice / The Castle / warelay 的信息"）而无需重读大量文件
- 观点/偏好的稳定性（以及变化时的证据）
- 时间约束（"2025 年 11 月期间什么是成立的？"）和冲突解决

## 设计目标

- **离线**：无需网络即可工作；可在笔记本/Castle 上运行；无云端依赖。
- **可解释**：检索到的条目应可溯源（文件 + 位置）且与推理结果可分离。
- **低仪式感**：每日记录保持 Markdown 格式，无需繁重的 schema 工作。
- **增量式**：v1 仅用全文搜索即可发挥作用；语义/向量和图谱是可选升级。
- **智能体友好**：使"在 token 预算内召回"变得简单（返回小型事实包）。

## 北极星模型（Hindsight × Letta）

需要融合两部分：

1. **Letta/MemGPT 风格的控制循环**

- 保持一个小型"核心"始终在上下文中（角色设定 + 关键用户事实）
- 其他所有内容都在上下文之外，通过工具检索
- 记忆写入是显式的工具调用（追加/替换/插入），持久化后在下一轮重新注入

2. **Hindsight 风格的记忆基底**

- 区分观察到的、认为的和总结的内容
- 支持 retain/recall/reflect
- 带有置信度的观点，可随证据演变
- 实体感知检索 + 时间查询（即使没有完整的知识图谱）

## 提议架构（Markdown 事实来源 + 派生索引）

### 规范存储（git 友好）

保持 `~/.openclaw/workspace` 作为规范的人类可读记忆。

建议的工作区布局：

```
~/.openclaw/workspace/
  memory.md                    # 小型：持久事实 + 偏好（核心级别）
  memory/
    YYYY-MM-DD.md              # 每日日志（追加；叙事性）
  bank/                        # "类型化"记忆页面（稳定、可审查）
    world.md                   # 关于世界的客观事实
    experience.md              # 智能体做过什么（第一人称）
    opinions.md                # 主观偏好/判断 + 置信度 + 证据指针
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

说明：

- **每日日志保持为每日日志**。无需将其转为 JSON。
- `bank/` 文件是**经过整理的**，由反思任务生成，仍可手动编辑。
- `memory.md` 保持"小型 + 核心级别"：你希望 Clawd 每次会话都能看到的内容。

### 派生存储（机器召回）

在工作区下添加派生索引（不一定纳入 git 追踪）：

```
~/.openclaw/workspace/.memory/index.sqlite
```

底层支持：

- SQLite schema，用于事实 + 实体链接 + 观点元数据
- SQLite **FTS5**，用于词法召回（快速、轻量、离线）
- 可选的嵌入表，用于语义召回（仍然离线）

索引始终**可从 Markdown 重建**。

## Retain / Recall / Reflect（运行循环）

### Retain：将每日日志规范化为"事实"

Hindsight 在此处的关键洞察：存储**叙事性的、自包含的事实**，而非零散片段。

`memory/YYYY-MM-DD.md` 的实用规则：

- 在一天结束时（或期间），添加一个 `## Retain` 部分，包含 2–5 个要点，要求：
  - 叙事性（保留跨轮次上下文）
  - 自包含（后续单独查看也能理解）
  - 标注类型 + 实体提及

示例：

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy's birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

最小化解析：

- 类型前缀：`W`（世界）、`B`（经历/传记）、`O`（观点）、`S`（观察/摘要；通常自动生成）
- 实体：`@Peter`、`@warelay` 等（slug 映射到 `bank/entities/*.md`）
- 观点置信度：`O(c=0.0..1.0)` 可选

如果不想让作者考虑这些：反思任务可以从日志的其余部分推断这些要点，但显式的 `## Retain` 部分是最简单的"质量杠杆"。

### Recall：在派生索引上查询

召回应支持：

- **词法**："查找精确术语/名称/命令"（FTS5）
- **实体**："告诉我关于 X 的信息"（实体页面 + 实体关联的事实）
- **时间**："11 月 27 日前后发生了什么"/"上周以来"
- **观点**："Peter 偏好什么？"（附带置信度 + 证据）

返回格式应对智能体友好并引用来源：

- `kind`（`world|experience|opinion|observation`）
- `timestamp`（来源日期，或提取的时间范围（如存在））
- `entities`（`["Peter","warelay"]`）
- `content`（叙事性事实）
- `source`（`memory/2025-11-27.md#L12` 等）

### Reflect：生成稳定页面 + 更新信念

反思是一个定时任务（每日或心跳 `ultrathink`），它：

- 根据近期事实更新 `bank/entities/*.md`（实体摘要）
- 根据强化/矛盾更新 `bank/opinions.md` 的置信度
- 可选地提议对 `memory.md` 的编辑（"核心级别"持久事实）

观点演变（简单、可解释）：

- 每个观点包含：
  - 陈述
  - 置信度 `c ∈ [0,1]`
  - 最后更新时间
  - 证据链接（支持 + 矛盾的事实 ID）
- 当新事实到达时：
  - 通过实体重叠 + 相似度查找候选观点（先 FTS，后嵌入）
  - 以小增量更新置信度；大幅变动需要强矛盾 + 反复出现的证据

## CLI 集成：独立 vs 深度集成

建议：**深度集成到 OpenClaw**，但保持核心库可分离。

### 为什么集成到 OpenClaw？

- OpenClaw 已经知道：
  - 工作区路径（`agents.defaults.workspace`）
  - 会话模型 + 心跳
  - 日志 + 故障排除模式
- 你希望智能体自身调用这些工具：
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### 为什么仍然拆分为库？

- 保持记忆逻辑可在无 Gateway网关/运行时的情况下测试
- 可在其他上下文中复用（本地脚本、未来的桌面应用等）

形态：
记忆工具计划作为一个小型 CLI + 库层，但目前仅处于探索阶段。

## "S-Collide" / SuCo：何时使用（研究）

如果"S-Collide"指的是 **SuCo（Subspace Collision）**：这是一种近似最近邻检索方法，通过在子空间中使用学习/结构化碰撞来实现强召回率/延迟权衡（论文：arXiv 2411.14754, 2024）。

对于 `~/.openclaw/workspace` 的务实建议：

- **不要从** SuCo 开始。
- 从 SQLite FTS +（可选的）简单嵌入开始；你将立即获得大部分用户体验收益。
- 仅在以下情况时考虑 SuCo/HNSW/ScaNN 级别的方案：
  - 语料库很大（数万/数十万个片段）
  - 暴力嵌入搜索变得太慢
  - 召回质量明显受限于词法搜索

离线友好的替代方案（按复杂度递增）：

- SQLite FTS5 + 元数据过滤（零 ML）
- 嵌入 + 暴力搜索（如果片段数量少，效果出乎意料地好）
- HNSW 索引（常见、稳健；需要库绑定）
- SuCo（研究级别；如果有可嵌入的可靠实现则很有吸引力）

开放问题：

- 在你的机器（笔记本 + 台式机）上，**最佳**的离线嵌入模型是什么，用于"个人助手记忆"？
  - 如果已有 Ollama：使用本地模型进行嵌入；否则在工具链中附带一个小型嵌入模型。

## 最小可用试点

如果你想要一个最小但仍然有用的版本：

- 添加 `bank/` 实体页面和每日日志中的 `## Retain` 部分。
- 使用 SQLite FTS 进行带引用（路径 + 行号）的召回。
- 仅在召回质量或规模有需求时才添加嵌入。

## 参考资料

- Letta / MemGPT 概念："核心记忆块" + "归档记忆" + 工具驱动的自编辑记忆。
- Hindsight 技术报告："retain / recall / reflect"、四网络记忆、叙事性事实提取、观点置信度演变。
- SuCo：arXiv 2411.14754 (2024)："Subspace Collision" 近似最近邻检索。
