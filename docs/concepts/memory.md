---
summary: "OpenClaw 如何跨会话记住事物"
title: "内存概述"
read_when:
  - 您想了解内存如何工作
  - 您想知道要编写哪些内存文件
---

OpenClaw 通过在 Agent 工作区中写入**纯 Markdown 文件**来记住事物。模型只"记住"保存到磁盘的内容 —— 没有隐藏状态。

## 工作原理

您的 Agent 有三个内存相关文件：

- **`MEMORY.md`** — 长期记忆。持久的事实、偏好和决定。在每个 DM 会话开始时加载。
- **`memory/YYYY-MM-DD.md`** — 每日笔记。运行上下文和观察。今天和昨天的笔记自动加载。
- **`DREAMS.md`**（可选）—— 梦想日记和梦想 sweep 摘要，用于人工审查，包括基于事实的历史 backfill 条目。

这些文件位于 Agent 工作区（默认 `~/.openclaw/workspace`）。

<Tip>
如果您希望 Agent 记住某些内容，只需问它："记住我更喜欢 TypeScript。"它会写入适当的文件。
</Tip>

## 内存工具

Agent 有两个用于处理内存的工具：

- **`memory_search`** — 使用语义搜索查找相关笔记，即使措辞与原始内容不同。
- **`memory_get`** — 读取特定的内存文件或行范围。

两个工具都由活动的内存插件提供（默认：`memory-core`）。

## Memory Wiki 配套插件

如果您希望持久内存更像维护的知识库而不是原始笔记，使用捆绑的 `memory-wiki` 插件。

`memory-wiki` 将持久知识编译成 wiki vault，具有：

- 确定性页面结构
- 结构化声明和证据
- 矛盾和新鲜度追踪
- 生成的仪表板
- 面向 Agent/运行时消费者的编译摘要
- wiki 原生工具如 `wiki_search`、`wiki_get`、`wiki_apply` 和 `wiki_lint`

它不替换活动的内存插件。活动内存插件仍拥有召回、提升和梦想。`memory-wiki` 在其旁边添加了丰富的 provenance 知识层。

参见 [Memory Wiki](/plugins/memory-wiki)。

## 内存搜索

当配置了 embedding 提供商时，`memory_search` 使用**混合搜索** —— 结合向量相似性（语义含义）和关键词匹配（精确术语如 ID 和代码符号）。一旦您有任何一个支持提供商的 API key，它就能开箱即用。

<Info>
OpenClaw 从可用的 API keys 自动检测您的 embedding 提供商。如果您配置了 OpenAI、Gemini、Voyage 或 Mistral key，内存搜索会自动启用。
</Info>

有关搜索如何工作、调优选项和提供商设置的详细信息，请参见 [Memory Search](/concepts/memory-search)。

## 内存后端

<CardGroup cols={3}>
<Card title="Builtin（默认）" icon="database" href="/concepts/memory-builtin">
  基于 SQLite。开箱即用，支持关键词搜索、向量相似性和混合搜索。无需额外依赖。
</Card>
<Card title="QMD" icon="search" href="/concepts/memory-qmd">
  本地优先的 sidecar，带 reranking、query expansion 和索引工作区外目录的能力。
</Card>
<Card title="Honcho" icon="brain" href="/concepts/memory-honcho">
  AI 原生跨会话内存，带用户建模、语义搜索和多 Agent 感知。插件安装。
</Card>
<Card title="LanceDB" icon="layers" href="/plugins/memory-lancedb">
  捆绑的 LanceDB 支持的内存，带 OpenAI-compatible embeddings、自动召回、自动捕获和本地 Ollama embedding 支持。
</Card>
</CardGroup>

## 知识 wiki 层

<CardGroup cols={1}>
<Card title="Memory Wiki" icon="book" href="/plugins/memory-wiki">
  将持久内存编译成丰富的 provenance wiki vault，带声明、仪表板、桥接模式和 Obsidian 友好工作流。
</Card>
</CardGroup>

## 自动内存刷新

在 [compaction](/concepts/compaction) 总结您的对话之前，OpenClaw 运行一个静默 turn，提醒 Agent 将重要上下文保存到内存文件。这是默认开启的 —— 您不需要配置任何东西。

要将该 housekeeping turn 保持在本地模型上，设置精确的 memory-flush 模型覆盖：

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "memoryFlush": {
          "model": "ollama/qwen3:8b"
        }
      }
    }
  }
}
```

该覆盖仅适用于 memory-flush turn，不继承活动会话回退链。

<Tip>
内存刷新防止 compaction 期间的上下文丢失。如果您的 Agent 在对话中有重要事实尚未写入文件，它们将在摘要发生前自动保存。
</Tip>

## 梦想

梦想是内存的可选后台整合过程。它收集短期信号，对候选进行评分，只将符合条件的项目提升到长期内存（`MEMORY.md`）。

它旨在保持长期内存高信号：

- **选择加入**：默认禁用。
- **调度**：启用时，`memory-core` 自动管理一个循环 cron 任务进行完整的梦想 sweep。
- **阈值化**：提升必须通过评分、召回频率和查询多样性门控。
- **可审查**：阶段摘要和日记条目写入 `DREAMS.md` 以供人工审查。

有关阶段行为、评分信号和梦想日记详细信息，请参见 [Dreaming](/concepts/dreaming)。

## 基于事实的 backfill 和实时提升

梦想系统现在有两个密切相关的审查通道：

- **Live dreaming** 从 `memory/.dreams/` 下的短期梦想存储工作，这是正常深度阶段用于决定什么可以升入 `MEMORY.md` 的。
- **Grounded backfill** 读取历史的 `memory/YYYY-MM-DD.md` 笔记作为独立的日子文件，并将结构化审查输出写入 `DREAMS.md`。

当您想重放较旧的笔记并检查系统认为什么是持久的时候，基于事实的 backfill 很有用，而无需手动编辑 `MEMORY.md`。

当您使用：

```bash
openclaw memory rem-backfill --path ./memory --stage-short-term
```

基于事实的持久候选不会直接提升。它们被 staged 到正常深度阶段已经使用的相同短期梦想存储。这意味着：

- `DREAMS.md` 保持人工审查表面。
- 短期存储保持机器面向的排名表面。
- `MEMORY.md` 仍仅由深度提升写入。

如果您认为重放无用，可以删除 staged 的 artifacts 而不触及普通日记条目或正常召回状态：

```bash
openclaw memory rem-backfill --rollback
openclaw memory rem-backfill --rollback-short-term
```

## CLI

```bash
openclaw memory status          # 检查索引状态和提供商
openclaw memory search "query"  # 从命令行搜索
openclaw memory index --force   # 重建索引
```

## 进一步阅读

- [Builtin memory engine](/concepts/memory-builtin)：默认 SQLite 后端。
- [QMD memory engine](/concepts/memory-qmd)：高级本地优先 sidecar。
- [Honcho memory](/concepts/memory-honcho)：AI 原生跨会话内存。
- [Memory LanceDB](/plugins/memory-lancedb)：带 OpenAI-compatible embeddings 的 LanceDB 支持插件。
- [Memory Wiki](/plugins/memory-wiki)：编译的知识 vault 和 wiki 原生工具。
- [Memory search](/concepts/memory-search)：搜索管道、提供商和调优。
- [Dreaming](/concepts/dreaming)：从短期召回后台提升到长期内存。
- [Memory configuration reference](/reference/memory-config)：所有配置旋钮。
- [Compaction](/concepts/compaction)：compaction 如何与内存交互。

## 相关

- [Active memory](/concepts/active-memory)
- [Memory search](/concepts/memory-search)
- [Builtin memory engine](/concepts/memory-builtin)
- [Honcho memory](/concepts/memory-honcho)
- [Memory LanceDB](/plugins/memory-lancedb)
