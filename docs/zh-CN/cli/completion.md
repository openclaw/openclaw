---
summary: "`openclaw completion` CLI 命令参考（生成/安装 shell 补全脚本）"
read_when:
  - 需要为 zsh/bash/fish/PowerShell 生成 shell 补全
  - 需要在 OpenClaw 状态下缓存补全脚本
title: "completion"
---

# `openclaw completion`

生成 shell 补全脚本，并可选择安装到你的 shell 配置文件中。

## 用法

```bash
openclaw completion
openclaw completion --shell zsh
openclaw completion --install
openclaw completion --shell fish --install
openclaw completion --write-state
openclaw completion --shell bash --write-state
```

## 选项

- `-s, --shell <shell>`: shell 目标（`zsh`、`bash`、`powershell`、`fish`；默认：`zsh`）
- `-i, --install`: 通过向 shell 配置文件添加 source 行来安装补全
- `--write-state`: 将补全脚本写入 `$OPENCLAW_STATE_DIR/completions`，不打印到 stdout
- `-y, --yes`: 跳过安装确认提示

## 注意事项

- `--install` 在你的 shell 配置文件中写入一个小的 "OpenClaw Completion" 块，并指向缓存的脚本。
- 不使用 `--install` 或 `--write-state` 时，命令将脚本打印到 stdout。
- 补全生成会急切加载命令树，因此嵌套子命令也会被包含。