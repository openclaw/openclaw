---
summary: "`openclaw completion` CLI 参考（生成/安装 Shell 补全脚本）"
read_when:
  - 需要 zsh/bash/fish/PowerShell 的命令补全
  - 需要将补全脚本缓存到 OpenClaw 状态目录
title: "completion"
---

# `openclaw completion`

生成 Shell 补全脚本，并可选择自动安装到 Shell 配置文件中。

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

- `-s, --shell <shell>`：目标 Shell（`zsh`、`bash`、`powershell`、`fish`；默认：`zsh`）
- `-i, --install`：安装补全，将 source 行添加到 Shell 配置文件
- `--write-state`：将补全脚本写入 `$OPENCLAW_STATE_DIR/completions`，不输出到终端
- `-y, --yes`：跳过安装确认提示

## 说明

- `--install` 会在 Shell 配置文件中写入一个 "OpenClaw Completion" 代码块，指向缓存的补全脚本。
- 不加 `--install` 或 `--write-state` 时，命令会将脚本输出到标准输出。
- 补全生成会预加载命令树，以包含所有嵌套子命令。
