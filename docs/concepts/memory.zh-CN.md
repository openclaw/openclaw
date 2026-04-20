---
title: "内存概览"
summary: "OpenClaw如何跨会话记住事情"
read_when:
  - 你想了解内存如何工作
  - 你想知道应该编写哪些内存文件
---

# 内存概览

OpenClaw通过在代理工作区中写入**纯Markdown文件**来记住事情。模型只"记住"保存到磁盘的内容——没有隐藏状态。

## 工作原理

你的代理有三个与内存相关的文件：

- **`MEMORY.md`**——长期记忆。持久的事实、偏好和决策。在每个DM会话开始时加载。
- **`memory/YYYY-MM-DD.md`**——每日笔记。运行上下文和观察结果。今天和昨天的笔记会自动加载。
- **`DREAMS.md`**（可选）——供人类审查的梦境日记和做梦扫描摘要，包括基于历史的回填条目。

这些文件位于代理工作区（默认 `~/.openclaw/workspace`）。

<Tip>
如果你想让你的代理记住某件事，只需告诉它："记住我更喜欢TypeScript。" 它会将其写入适当的文件。
</Tip>

## 内存工具

代理有两个用于处理内存的工具：

- **`memory_search`**——使用语义搜索查找相关笔记，即使措辞与原始内容不同。
- **`memory_get`**——读取特定的内存文件或行范围。

这两个工具都由活动内存插件（默认：`memory-core`）提供。

## Memory Wiki 配套插件

如果你希望持久内存的行为更像一个维护的知识库，而不仅仅是原始笔记，请使用捆绑的 `memory-wiki` 插件。

`memory-wiki` 将持久知识编译到一个维基库中，具有：

- 确定性页面结构
- 结构化声明和证据
- 矛盾和新鲜度跟踪
- 生成的仪表板
- 为代理/运行时消费者编译的摘要
- 维基原生工具，如 `wiki_search`、`wiki_get`、`wiki_apply` 和 `wiki_lint`

它不会替换活动内存插件。活动内存插件仍然负责召回、提升和做梦。`memory-wiki` 在其旁边添加了一个富含来源的知识层。

请参阅 [Memory Wiki](/plugins/memory-wiki)。

## 内存搜索

当配置了嵌入提供程序时，`memory_search` 使用**混合搜索**——结合向量相似度（语义含义）和关键字匹配（如ID和代码符号等精确术语）。一旦你为任何支持的提供程序配置了API密钥，这就可以开箱即用。

<Info>
OpenClaw会从可用的API密钥中自动检测你的嵌入提供程序。如果你配置了OpenAI、Gemini、Voyage或Mistral密钥，内存搜索会自动启用。
</Info>

有关搜索如何工作、调优选项和提供程序设置的详细信息，请参阅 [内存搜索](/concepts/memory-search)。

## 内存后端

<CardGroup cols={3}>
<Card title="内置（默认）" icon="database" href="/concepts/memory-builtin">
基于SQLite。开箱即用，支持关键字搜索、向量相似度和混合搜索。无额外依赖。
</Card>
<Card title="QMD" icon="search" href="/concepts/memory-qmd">
本地优先的边车，具有重排序、查询扩展和索引工作区外目录的能力。
</Card>
<Card title="Honcho" icon="brain" href="/concepts/memory-honcho">
AI原生跨会话内存，具有用户建模、语义搜索和多代理感知。需要插件安装。
</Card>
</CardGroup>

## 知识维基层

<CardGroup cols={1}>
<Card title="Memory Wiki" icon="book" href="/plugins/memory-wiki">
将持久内存编译成富含来源的维基库，包含声明、仪表板、桥接模式和Obsidian友好的工作流。
</Card>
</CardGroup>

## 自动内存刷新

在[压缩](/concepts/compaction)总结你的对话之前，OpenClaw会运行一个静默回合，提醒代理将重要上下文保存到内存文件中。这默认是开启的——你不需要配置任何东西。

<Tip>
内存刷新可防止在压缩过程中丢失上下文。如果你的代理在对话中有重要事实尚未写入文件，它们会在总结发生前自动保存。
</Tip>

## 做梦

做梦是内存的可选后台整合过程。它收集短期信号，为候选项目评分，并仅将合格项目提升到长期内存（`MEMORY.md`）中。

它旨在保持长期内存的高信号：

- **选择加入**：默认禁用。
- **计划**：启用时，`memory-core` 会自动管理一个用于完整做梦扫描的定期cron作业。
- **阈值**：提升必须通过分数、召回频率和查询多样性门控。
- **可审查**：阶段摘要和日记条目会写入 `DREAMS.md` 以供人类审查。

有关阶段行为、评分信号和梦境日记详情，请参阅 [做梦](/concepts/dreaming)。

## 基于历史的回填和实时提升

做梦系统现在有两个密切相关的审查通道：

- **实时做梦** 从 `memory/.dreams/` 下的短期做梦存储工作，是正常深度阶段在决定什么可以升级到 `MEMORY.md` 时使用的。
- **基于历史的回填** 将历史 `memory/YYYY-MM-DD.md` 笔记作为独立的日文件读取，并将结构化审查输出写入 `DREAMS.md`。

当你想重放旧笔记并检查系统认为什么是持久的，而无需手动编辑 `MEMORY.md` 时，基于历史的回填非常有用。

当你使用：

```bash
openclaw memory rem-backfill --path ./memory --stage-short-term
```

基于历史的持久候选项目不会直接提升。它们会被暂存到正常深度阶段已经使用的同一个短期做梦存储中。这意味着：

- `DREAMS.md` 保持为人类审查表面。
- 短期存储保持为机器面向的排名表面。
- `MEMORY.md` 仍然只能通过深度提升写入。

如果你认为重放没有用，你可以删除暂存的工件，而不影响普通日记条目或正常的召回状态：

```bash
openclaw memory rem-backfill --rollback
openclaw memory rem-backfill --rollback-short-term
```

## 命令行界面

```bash
openclaw memory status          # 检查索引状态和提供程序
openclaw memory search "查询"  # 从命令行搜索
openclaw memory index --force   # 重建索引
```

## 进一步阅读

- [内置内存引擎](/concepts/memory-builtin)——默认SQLite后端
- [QMD内存引擎](/concepts/memory-qmd)——高级本地优先边车
- [Honcho内存](/concepts/memory-honcho)——AI原生跨会话内存
- [Memory Wiki](/plugins/memory-wiki)——编译的知识库和维基原生工具
- [内存搜索](/concepts/memory-search)——搜索管道、提供程序和调优
- [做梦](/concepts/dreaming)——从短期回收到长期内存的后台提升
- [内存配置参考](/reference/memory-config)——所有配置选项
- [压缩](/concepts/compaction)——压缩如何与内存交互