---
summary: "`openclaw completion` 的 CLI 参考（生成/安装 Shell 补全脚本）"
read_when:
  - 你需要为 zsh/bash/fish/PowerShell 配置自动补全
  - 你需要将补全脚本缓存到 OpenClaw 状态目录
title: "completion"
---

# `openclaw completion`

生成 Shell 补全脚本，并可选择自动安装到你的 Shell 配置文件中。

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
- `-i, --install`：将补全脚本安装到你的 Shell 配置文件中
- `--write-state`：将补全脚本写入 `$OPENCLAW_STATE_DIR/completions`，不输出到标准输出
- `-y, --yes`：跳过安装确认提示

## 说明

- `--install` 会在你的 Shell 配置文件中添加一个 "OpenClaw Completion" 代码块，指向缓存的补全脚本。
- 如果不使用 `--install` 或 `--write-state`，命令会将脚本内容打印到标准输出。
- 补全脚本生成时会预加载命令树，以确保嵌套子命令也被包含在内。
