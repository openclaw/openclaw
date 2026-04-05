---
read_when:
  - 你正在进行首次运行设置，但不使用完整的 CLI 新手引导
  - 你想设置默认工作区路径
summary: "`mullusi setup` 的 CLI 参考（初始化配置 + 工作区）"
title: setup
x-i18n:
  generated_at: "2026-03-16T06:21:20Z"
  model: gpt-5.4
  provider: openai
  source_hash: b6d6fef6642a4fdf9880ea4f752981b5ed0404289274ee3429ee31702873e3ea
  source_path: cli/setup.md
  workflow: 15
---

# `mullusi setup`

初始化 `~/.mullusi/mullusi.json` 和智能体工作区。

相关内容：

- 入门指南：[入门指南](/start/getting-started)
- CLI 新手引导：[CLI 新手引导](/start/wizard)

## 示例

```bash
mullusi setup
mullusi setup --workspace ~/.mullusi/workspace
```

通过 setup 运行新手引导：

```bash
mullusi setup --wizard
```
