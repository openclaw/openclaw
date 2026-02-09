---
summary: "「openclaw tui」的 CLI 參考（連線至 Gateway 閘道器 的終端機 UI）"
read_when:
  - 你想要用於 Gateway 閘道器 的終端機 UI（適合遠端使用）
  - 你想要從腳本傳遞 url／token／session
title: "tui"
---

# `openclaw tui`

開啟連線至 Gateway 閘道器 的終端機 UI。

34. 相關：

- TUI 指南：[TUI](/web/tui)

## 範例

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
