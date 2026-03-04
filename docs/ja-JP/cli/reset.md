---
summary: "`openclaw reset`（ローカルの状態/設定をリセット）の CLI リファレンス"
read_when:
  - CLI をインストールしたまま、ローカルの状態を消去したい場合
  - 削除される内容のドライランを実行したい場合
title: "reset"
---

# `openclaw reset`

ローカルの設定/状態をリセットします（CLI はインストールされたままになります）。

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
