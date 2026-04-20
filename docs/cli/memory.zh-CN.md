---
summary: "`openclaw memory`的CLI参考（status/index/search/promote/promote-explain/rem-harness）"
read_when:
  - 您想索引或搜索语义记忆
  - 您正在调试记忆可用性或索引
  - 您想将回忆的短期记忆提升到`MEMORY.md`
title: "memory"
---

# `openclaw memory`

管理语义记忆索引和搜索。
由活动的记忆插件提供（默认：`memory-core`；设置`plugins.slots.memory = "none"`禁用）。

相关：

- 记忆概念：[Memory](/concepts/memory)
- 记忆维基：[Memory Wiki](/plugins/memory-wiki)
- 维基CLI：[wiki](/cli/wiki)
- 插件：[Plugins](/tools/plugin)

## 示例

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --fix
openclaw memory index --force
openclaw memory search "meeting notes"
openclaw memory search --query "deployment" --max-results 20
openclaw memory promote --limit 10 --min-score 0.75
openclaw memory promote --apply
openclaw memory promote --json --min-recall-count 0 --min-unique-queries 0
openclaw memory promote-explain "router vlan"
openclaw memory promote-explain "router vlan" --json
openclaw memory rem-harness
openclaw memory rem-harness --json
openclaw memory status --json
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## 选项

`memory status`和`memory index`：

- `--agent <id>`: 限定到单个代理。没有它，这些命令为每个配置的代理运行；如果没有配置代理列表，它们回退到默认代理。
- `--verbose`: 在探测和索引期间发出详细日志。

`memory status`：

- `--deep`: 探测向量+嵌入可用性。
- `--index`: 如果存储脏了，运行重新索引（意味着`--deep`）。
- `--fix`: 修复过时的回忆锁并标准化提升元数据。
- `--json`: 打印JSON输出。

`memory index`：

- `--force`: 强制完全重新索引。

`memory search`：

- 查询输入：传递位置`[query]`或`--query <text>`。
- 如果两者都提供，`--query`获胜。
- 如果两者都不提供，命令以错误退出。
- `--agent <id>`: 限定到单个代理（默认：默认代理）。
- `--max-results <n>`: 限制返回的结果数量。
- `--min-score <n>`: 过滤掉低分数匹配。
- `--json`: 打印JSON结果。

`memory promote`：

预览并应用短期记忆提升。

```bash
openclaw memory promote [--apply] [--limit <n>] [--include-promoted]
```

- `--apply` -- 将提升写入`MEMORY.md`（默认：仅预览）。
- `--limit <n>` -- 限制显示的候选数量。
- `--include-promoted` -- 包括在先前周期中已经提升的条目。

完整选项：

- 使用加权提升信号（`frequency`、`relevance`、`query diversity`、`recency`、`consolidation`、`conceptual richness`）对`memory/YYYY-MM-DD.md`中的短期候选进行排序。
- 使用来自记忆回忆和每日摄入通过的短期信号，加上轻度/REM阶段强化信号。
- 当启用做梦时，`memory-core`自动管理一个cron作业，在后台运行完整扫描（`light -> REM -> deep`）（不需要手动`openclaw cron add`）。
- `--agent <id>`: 限定到单个代理（默认：默认代理）。
- `--limit <n>`: 最大返回/应用的候选数。
- `--min-score <n>`: 最小加权提升分数。
- `--min-recall-count <n>`: 候选所需的最小回忆计数。
- `--min-unique-queries <n>`: 候选所需的最小不同查询计数。
- `--apply`: 将选定的候选追加到`MEMORY.md`并标记为已提升。
- `--include-promoted`: 在输出中包括已经提升的候选。
- `--json`: 打印JSON输出。

`memory promote-explain`：

解释特定的提升候选及其分数分解。

```bash
openclaw memory promote-explain <selector> [--agent <id>] [--include-promoted] [--json]
```

- `<selector>`: 要查找的候选键、路径片段或片段片段。
- `--agent <id>`: 限定到单个代理（默认：默认代理）。
- `--include-promoted`: 包括已经提升的候选。
- `--json`: 打印JSON输出。

`memory rem-harness`：

预览REM反思、候选事实和深度提升输出，不写入任何内容。

```bash
openclaw memory rem-harness [--agent <id>] [--include-promoted] [--json]
```

- `--agent <id>`: 限定到单个代理（默认：默认代理）。
- `--include-promoted`: 包括已经提升的深度候选。
- `--json`: 打印JSON输出。

## 做梦

做梦是后台记忆巩固系统，具有三个协作阶段：**light**（排序/暂存短期材料）、**deep**（将持久事实提升到`MEMORY.md`）和**REM**（反思和表面主题）。

- 通过`plugins.entries.memory-core.config.dreaming.enabled: true`启用。
- 通过聊天中的`/dreaming on|off`切换（或通过`/dreaming status`检查）。
- 做梦以一个管理的扫描计划运行（`dreaming.frequency`），并按顺序执行阶段：light、REM、deep。
- 只有deep阶段将持久记忆写入`MEMORY.md`。
- 人类可读的阶段输出和日记条目被写入`DREAMS.md`（或现有的`dreams.md`），可选的每阶段报告在`memory/dreaming/<phase>/YYYY-MM-DD.md`。
- 排名使用加权信号：回忆频率、检索相关性、查询多样性、时间新近度、跨天巩固和派生概念丰富度。
- 提升在写入`MEMORY.md`之前重新读取实时每日笔记，因此编辑或删除的短期片段不会从过时的回忆存储快照中提升。
- 计划和手动`memory promote`运行共享相同的深度阶段默认值，除非您通过CLI阈值覆盖。
- 自动运行在配置的记忆工作区之间散开。

默认调度：

- **扫描节奏**：`dreaming.frequency = 0 3 * * *`
- **深度阈值**：`minScore=0.8`，`minRecallCount=3`，`minUniqueQueries=3`，`recencyHalfLifeDays=14`，`maxAgeDays=30`

示例：

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

注意事项：

- `memory index --verbose`打印每阶段详细信息（提供者、模型、源、批处理活动）。
- `memory status`包括通过`memorySearch.extraPaths`配置的任何额外路径。
- 如果有效活跃的记忆远程API密钥字段配置为SecretRefs，该命令从活跃的gateway快照解析这些值。如果gateway不可用，该命令快速失败。
- Gateway版本偏差注意：此命令路径需要支持`secrets.resolve`的gateway；较旧的gateway返回未知方法错误。
- 使用`dreaming.frequency`调整计划扫描节奏。深度提升策略否则是内部的；当您需要一次性手动覆盖时，在`memory promote`上使用CLI标志。
- `memory rem-harness --path <file-or-dir> --grounded`预览来自历史每日笔记的接地`What Happened`、`Reflections`和`Possible Lasting Updates`，不写入任何内容。
- `memory rem-backfill --path <file-or-dir>`将可逆的接地日记条目写入`DREAMS.md`以供UI审查。
- `memory rem-backfill --path <file-or-dir> --stage-short-term`还将接地的持久候选种子到实时短期提升存储中，以便正常的深度阶段可以对它们进行排序。
- `memory rem-backfill --rollback`删除先前写入的接地日记条目，`memory rem-backfill --rollback-short-term`删除先前暂存的接地短期候选。
- 有关完整的阶段描述和配置参考，请参阅[Dreaming](/concepts/dreaming)。