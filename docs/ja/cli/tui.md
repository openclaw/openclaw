---
summary: "CLI リファレンス：`openclaw tui`（Gateway（ゲートウェイ）に接続されたターミナル UI）"
read_when:
  - Gateway（ゲートウェイ）向けのターミナル UI（リモートフレンドリー）が必要な場合
  - スクリプトから url / token / session を渡したい場合
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:18Z
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
