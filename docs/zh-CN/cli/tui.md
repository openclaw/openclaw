---
read_when:
  - 你想要一个连接 Gateway 网关的终端 UI（支持远程）
  - 你想从脚本传递 url/token/session
summary: "`openclaw tui` 的 CLI 参考（连接到 Gateway 网关的终端 UI）"
title: tui
x-i18n:
  generated_at: "2026-02-03T07:45:20Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f0a97d92e08746a9d6a4f31d361ccad9aea4c3dc61cfafb310d88715f61cfb64
  source_path: cli/tui.md
  workflow: 15
---

# `openclaw tui`

打开连接到 Gateway 网关的终端 UI。

相关：

- TUI 指南：[TUI](/web/tui)

## 示例

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
