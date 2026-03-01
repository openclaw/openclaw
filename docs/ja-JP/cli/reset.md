---
summary: "`openclaw reset` の CLI リファレンス（ローカルステート/設定のリセット）"
read_when:
  - CLI をインストールしたまま、ローカルステートを消去したい場合
  - 削除対象のドライランを確認したい場合
title: "reset"
---

# `openclaw reset`

ローカルの設定/ステートをリセットします（CLI はインストールされたまま残ります）。

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
