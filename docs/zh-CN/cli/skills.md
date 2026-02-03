---
read_when:
  - 想要查看哪些 Skills 可用且可以运行
  - 想要调试 Skills 缺失的二进制文件/环境变量/配置
summary: Skills 列表/信息/检查及 Skills 资格的 `openclaw skills` CLI 参考
title: skills
x-i18n:
  generated_at: "2026-02-01T20:21:28Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 7878442c88a27ec8033f3125c319e9a6a85a1c497a404a06112ad45185c261b0
  source_path: cli/skills.md
  workflow: 14
---

# `openclaw skills`

检查 Skills（内置 + 工作区 + 托管覆盖），查看哪些符合条件以及哪些缺少依赖。

相关内容：

- Skills 系统：[Skills](/tools/skills)
- Skills配置：[Skills配置](/tools/skills-config)
- ClawHub 安装：[ClawHub](/tools/clawhub)

## 命令

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
