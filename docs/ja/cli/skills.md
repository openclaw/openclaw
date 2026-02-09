---
summary: "「openclaw skills」（list/info/check）の CLI リファレンスと、Skills の実行可否条件について"
read_when:
  - 利用可能で実行準備が整っている Skills を確認したいとき
  - Skills に必要なバイナリ／環境変数／設定の不足をデバッグしたいとき
title: "skills"
---

# `openclaw skills`

Skills（バンドル済み＋ワークスペース＋管理されたオーバーライド）を検査し、実行可能なものと要件不足のものを確認します。

関連項目:

- Skills システム: [Skills](/tools/skills)
- Skills 設定: [Skills config](/tools/skills-config)
- ClawHub インストール: [ClawHub](/tools/clawhub)

## コマンド

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
