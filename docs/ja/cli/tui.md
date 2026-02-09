---
summary: "CLI リファレンス：`openclaw tui`（Gateway（ゲートウェイ）に接続されたターミナル UI）"
read_when:
  - Gateway（ゲートウェイ）向けのターミナル UI（リモートフレンドリー）が必要な場合
  - スクリプトから url / token / session を渡したい場合
title: "tui"
---

# `openclaw tui`

Gateway（ゲートウェイ）に接続されたターミナル UI を開きます。

関連:

- TUI ガイド: [TUI](/web/tui)

## 例

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
