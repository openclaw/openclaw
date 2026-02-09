---
summary: "CLI リファレンス：`openclaw reset`（ローカルの状態／設定をリセット）"
read_when:
  - CLI をインストールしたままローカルの状態を消去したい場合
  - 削除される内容のドライランを確認したい場合
title: "リセット"
---

# `openclaw reset`

ローカルの設定／状態をリセットします（CLI はインストールされたままです）。

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
