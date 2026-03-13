---
summary: >-
  CLI reference for `openclaw completion` (generate/install shell completion
  scripts)
read_when:
  - You want shell completions for zsh/bash/fish/PowerShell
  - You need to cache completion scripts under OpenClaw state
title: completion
---

# `openclaw completion`

生成 shell 完成腳本，並可選擇將它們安裝到您的 shell 設定檔中。

## 使用方式

```bash
openclaw completion
openclaw completion --shell zsh
openclaw completion --install
openclaw completion --shell fish --install
openclaw completion --write-state
openclaw completion --shell bash --write-state
```

## Options

- `-s, --shell <shell>`: shell 目標 (`zsh`, `bash`, `powershell`, `fish`; 預設: `zsh`)
- `-i, --install`: 透過將來源行添加到您的 shell 設定檔來安裝補全
- `--write-state`: 編寫補全腳本到 `$OPENCLAW_STATE_DIR/completions` 而不輸出到 stdout
- `-y, --yes`: 跳過安裝確認提示

## Notes

- `--install` 在你的 shell 設定檔中寫入一個小的 "OpenClaw Completion" 區塊，並指向快取的腳本。
- 沒有 `--install` 或 `--write-state`，該命令會將腳本輸出到 stdout。
- 完成生成會積極加載命令樹，以便包含嵌套的子命令。
