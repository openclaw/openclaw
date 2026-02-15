---
summary: "openclaw tui 的 CLI 參考 (連接到 Gateway 的終端機使用者介面)"
read_when:
  - 您需要 Gateway 的終端機使用者介面 (遠端友善)
  - 您想從腳本傳遞 url/token/工作階段
title: "tui"
---

# `openclaw tui`

開啟連接到 Gateway 的終端機使用者介面。

相關資訊：

- TUI 指南：[TUI](/web/tui)

## 範例

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
