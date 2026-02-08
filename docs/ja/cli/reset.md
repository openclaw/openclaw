---
summary: "CLI リファレンス：`openclaw reset`（ローカルの状態／設定をリセット）"
read_when:
  - CLI をインストールしたままローカルの状態を消去したい場合
  - 削除される内容のドライランを確認したい場合
title: "リセット"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:10Z
---

# `openclaw reset`

ローカルの設定／状態をリセットします（CLI はインストールされたままです）。

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
