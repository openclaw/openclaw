---
summary: "`openclaw tui` の CLI リファレンス（Gateway に接続するターミナル UI）"
read_when:
  - Gateway 用のターミナル UI（リモート対応）
  - スクリプトから url/token/session を渡す場合
title: "tui"
---

# `openclaw tui`

Gateway に接続するターミナル UI を開きます。

関連:

- TUI ガイド: [TUI](/web/tui)

## 例

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
