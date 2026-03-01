---
summary: "`openclaw skills` の CLI リファレンス（list/info/check）とスキルの適格性"
read_when:
  - 利用可能で実行準備ができているスキルの確認
  - スキルに必要なバイナリ/環境/設定の欠落のデバッグ
title: "skills"
---

# `openclaw skills`

スキル（バンドル + ワークスペース + マネージドオーバーライド）を確認し、適格なものと要件が不足しているものを表示します。

関連:

- スキルシステム: [スキル](/tools/skills)
- スキル設定: [スキル設定](/tools/skills-config)
- ClawHub インストール: [ClawHub](/tools/clawhub)

## コマンド

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
