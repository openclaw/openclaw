---
read_when:
  - 想要使用 Gateway网关的终端 UI（支持远程）
  - 想要从脚本传递 url/token/session
summary: 连接到 Gateway网关的终端 UI 的 `openclaw tui` CLI 参考
title: tui
x-i18n:
  generated_at: "2026-02-01T20:21:31Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f0a97d92e08746a9d6a4f31d361ccad9aea4c3dc61cfafb310d88715f61cfb64
  source_path: cli/tui.md
  workflow: 14
---

# `openclaw tui`

打开连接到 Gateway网关的终端 UI。

相关内容：

- TUI 指南：[TUI](/tui)

## 示例

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
