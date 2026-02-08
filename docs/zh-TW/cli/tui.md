---
summary: "「openclaw tui」的 CLI 參考（連線至 Gateway 閘道器 的終端機 UI）"
read_when:
  - 你想要用於 Gateway 閘道器 的終端機 UI（適合遠端使用）
  - 你想要從腳本傳遞 url／token／session
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:29Z
---

# `openclaw tui`

開啟連線至 Gateway 閘道器 的終端機 UI。

相關：

- TUI 指南：[TUI](/web/tui)

## 範例

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
