---
summary: "`openclaw completion`的CLI参考（生成/安装shell完成脚本）"
read_when:
  - 您需要zsh/bash/fish/PowerShell的shell完成
  - 您需要在OpenClaw状态下缓存完成脚本
title: "completion"
---

# `openclaw completion`

生成shell完成脚本并可选地将它们安装到您的shell配置文件中。

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

- `-s, --shell <shell>`: shell目标（`zsh`、`bash`、`powershell`、`fish`；默认：`zsh`）
- `-i, --install`: 通过在shell配置文件中添加源行来安装完成
- `--write-state`: 将完成脚本写入`$OPENCLAW_STATE_DIR/completions`而不打印到stdout
- `-y, --yes`: 跳过安装确认提示

## 注意事项

- `--install`将一个小的"OpenClaw Completion"块写入您的shell配置文件，并将其指向缓存的脚本。
- 没有`--install`或`--write-state`，命令会将脚本打印到stdout。
- 完成生成会急切加载命令树，以便包含嵌套子命令。