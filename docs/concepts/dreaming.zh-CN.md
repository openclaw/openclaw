---
title: "做梦"
summary: "具有轻度、深度和快速眼动阶段以及梦境日记的背景记忆巩固"
read_when:
  - 你希望内存提升自动运行
  - 你想了解每个做梦阶段的作用
  - 你想在不污染 MEMORY.md 的情况下调整巩固
---

# 做梦

做梦是 `memory-core` 中的背景记忆巩固系统。它帮助 OpenClaw 将强烈的短期信号移动到持久内存中，同时保持过程可解释和可审查。

做梦是**可选的**，默认禁用。

## 做梦写入的内容

做梦保持两种输出：

- **机器状态** 在 `memory/.dreams/` 中（回忆存储、阶段信号、摄取检查点、锁）。
- **人类可读输出** 在 `DREAMS.md`（或现有的 `dreams.md`）和 `memory/dreaming/<phase>/YYYY-MM-DD.md` 下的可选阶段报告文件中。

长期提升仍然只写入 `MEMORY.md`。

## 阶段模型

做梦使用三个协作阶段：

| 阶段     | 目的                     | 持久写入         |
| -------- | ------------------------ | ---------------- |
| 轻度     | 排序和暂存最近的短期材料 | 否               |
| 深度     | 评分并提升持久候选       | 是 (`MEMORY.md`) |
| 快速眼动 | 反思主题和反复出现的想法 | 否               |

这些阶段是内部实现细节，不是单独的用户配置"模式"。

### 轻度阶段

轻度阶段摄取最近的每日记忆信号和回忆轨迹，对它们进行去重，并暂存候选行。

- 从短期回忆状态、最近的每日记忆文件和可用时的编辑会话记录中读取。
- 当存储包含内联输出时，写入管理的 `## Light Sleep` 块。
- 记录强化信号以供以后深度排名。
- 永远不写入 `MEMORY.md`。

### 深度阶段

深度阶段决定什么成为长期记忆。

- 使用加权评分和阈值门对候选进行排名。
- 需要通过 `minScore`、`minRecallCount` 和 `minUniqueQueries`。
- 在写入前从实时每日文件中重新水合片段，因此跳过过时/删除的片段。
- 将提升的条目附加到 `MEMORY.md`。
- 在 `DREAMS.md` 中写入 `## Deep Sleep` 摘要，并可选地写入 `memory/dreaming/deep/YYYY-MM-DD.md`。

### 快速眼动阶段

快速眼动阶段提取模式和反思信号。

- 从最近的短期轨迹构建主题和反思摘要。
- 当存储包含内联输出时，写入管理的 `## REM Sleep` 块。
- 记录深度排名使用的快速眼动强化信号。
- 永远不写入 `MEMORY.md`。

## 会话记录摄取

做梦可以将编辑过的会话记录摄取到做梦语料库中。当记录可用时，它们与每日记忆信号和回忆轨迹一起被输入到轻度阶段。个人和敏感内容在摄取前被编辑。

## 梦境日记

做梦还在 `DREAMS.md` 中保存叙事**梦境日记**。在每个阶段有足够的材料后，`memory-core` 运行一个尽力而为的后台子代理回合（使用默认运行时模型）并附加一个短日记条目。

这个日记用于人类在梦境 UI 中阅读，而不是提升源。做梦生成的日记/报告工件被排除在短期提升之外。只有有根据的记忆片段才有资格提升到 `MEMORY.md`。

还有一个用于审查和恢复工作的有根据的历史回填通道：

- `memory rem-harness --path ... --grounded` 预览来自历史 `YYYY-MM-DD.md` 笔记的有根据的日记输出。
- `memory rem-backfill --path ...` 将可逆的有根据的日记条目写入 `DREAMS.md`。
- `memory rem-backfill --path ... --stage-short-term` 将有根据的持久候选暂存到正常深度阶段已经使用的同一短期证据存储中。
- `memory rem-backfill --rollback` 和 `--rollback-short-term` 删除这些暂存的回填工件，而不触及普通日记条目或实时短期回忆。

控制 UI 暴露相同的日记回填/重置流程，以便你可以在梦境场景中检查结果，然后再决定有根据的候选是否值得提升。场景还显示一个独特的有根据通道，以便你可以看到哪些暂存的短期条目来自历史回放，哪些提升的项目是有根据主导的，并清除仅基于有根据的暂存条目，而不触及普通的实时短期状态。

## 深度排名信号

深度排名使用六个加权基础信号加上阶段强化：

| 信号       | 权重 | 描述                        |
| ---------- | ---- | --------------------------- |
| 频率       | 0.24 | 条目积累的短期信号数量      |
| 相关性     | 0.30 | 条目的平均检索质量          |
| 查询多样性 | 0.15 | 显示它的不同查询/天上下文   |
| 新近度     | 0.15 | 时间衰减的新鲜度分数        |
| 巩固       | 0.10 | 多天重复强度                |
| 概念丰富度 | 0.06 | 来自片段/路径的概念标签密度 |

轻度和快速眼动阶段命中从 `memory/.dreams/phase-signals.json` 添加一个小的时间衰减增强。

## 调度

启用后，`memory-core` 自动管理一个 cron 作业来进行完整的做梦扫描。每次扫描按顺序运行阶段：轻度 -> 快速眼动 -> 深度。

默认节奏行为：

| 设置                 | 默认        |
| -------------------- | ----------- |
| `dreaming.frequency` | `0 3 * * *` |

## 快速开始

启用做梦：

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

启用做梦并使用自定义扫描节奏：

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true,
            "timezone": "America/Los_Angeles",
            "frequency": "0 */6 * * *"
          }
        }
      }
    }
  }
}
```

## 斜杠命令

```
/dreaming status
/dreaming on
/dreaming off
/dreaming help
```

## CLI 工作流

使用 CLI 提升进行预览或手动应用：

```bash
openclaw memory promote
openclaw memory promote --apply
openclaw memory promote --limit 5
openclaw memory status --deep
```

手动 `memory promote` 默认使用深度阶段阈值，除非用 CLI 标志覆盖。

解释为什么特定候选会或不会提升：

```bash
openclaw memory promote-explain "router vlan"
openclaw memory promote-explain "router vlan" --json
```

预览快速眼动反思、候选事实和深度提升输出而不写入任何内容：

```bash
openclaw memory rem-harness
openclaw memory rem-harness --json
```

## 关键默认值

所有设置都位于 `plugins.entries.memory-core.config.dreaming` 下。

| 键          | 默认        |
| ----------- | ----------- |
| `enabled`   | `false`     |
| `frequency` | `0 3 * * *` |

阶段策略、阈值和存储行为是内部实现细节（非用户面对的配置）。

有关完整的键列表，请参阅 [内存配置参考](/reference/memory-config#dreaming)。

## 梦境 UI

启用后，网关**梦境**选项卡显示：

- 当前做梦启用状态
- 阶段级状态和管理扫描存在
- 短期、有根据、信号和今天提升的计数
- 下一次计划运行时间
- 用于暂存历史回放条目的独特有根据场景通道
- 由 `doctor.memory.dreamDiary` 支持的可展开梦境日记阅读器

## 相关

- [内存](/concepts/memory)
- [内存搜索](/concepts/memory-search)
- [memory CLI](/cli/memory)
- [内存配置参考](/reference/memory-config)
