---
summary: "`openclaw completion` CLI 参考（生成/安装 shell 补全脚本）"
read_when:
  - 你想要 zsh/bash/fish/PowerShell 的 shell 补全
  - 你需要在 OpenClaw 状态下缓存补全脚本
title: "completion"
---

# `openclaw completion`

生成 shell 补全脚本并可选安装到你的 shell 配置中。

## 用法

```bash
openclaw completion
openclaw completion --shell zsh
openclaw completion --install
openclaw completion --shell fish --install
```

## 选项

- `-s, --shell <shell>`: shell 目标 (`zsh`, `bash`, `powershell`, `fish`)
- `-i, --install`: 通过添加 source 行安装补全到你的 shell 配置
- `--write-state`: 将补全脚本写入 `$OPENCLAW_STATE_DIR/completions`
- `-y, --yes`: 跳过安装确认提示
