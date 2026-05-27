---
read_when:
  - 你想要索引或搜索语义记忆
  - 你正在调试记忆可用性或索引问题
summary: "`openclaw memory`（status/index/search）的 CLI 参考"
title: memory
x-i18n:
  generated_at: "2026-02-01T20:21:11Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 95a9e94306f95be2218a909be59be5bbaa5d31322b71b23564c71a89c3a3941a
  source_path: cli/memory.md
  workflow: 14
---

# `openclaw memory`

管理语义记忆的索引和搜索。
由活跃的记忆插件提供（默认：`memory-core`；设置 `plugins.slots.memory = "none"` 可禁用）。

相关内容：

- 记忆概念：[记忆](/concepts/memory)
- 插件：[插件](/tools/plugin)

## 示例

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## 选项

通用选项：

- `--agent <id>`：限定到单个智能体（默认：所有已配置的智能体）。
- `--verbose`：在探测和索引期间输出详细日志。

说明：

- `memory status --deep` 探测向量存储和嵌入模型的可用性。
- `memory status --deep --index` 在存储有未同步变更时运行重新索引。
- `memory index --verbose` 打印每个阶段的详细信息（提供商、模型、数据源、批处理活动）。
- `memory status` 包含通过 `memorySearch.extraPaths` 配置的所有额外路径。
