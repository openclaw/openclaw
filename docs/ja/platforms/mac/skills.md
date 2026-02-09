---
summary: "macOS の Skills 設定 UI と ゲートウェイ によるステータス"
read_when:
  - macOS の Skills 設定 UI を更新する場合
  - Skills のゲーティングやインストール動作を変更する場合
title: "Skills"
---

# Skills (macOS)

macOS アプリは、ゲートウェイ 経由で OpenClaw の Skills を表示します。Skills をローカルで解析することはありません。

## データソース

- `skills.status`（ゲートウェイ）は、すべての Skills に加えて、適格性および不足している要件を返します
  （バンドルされた Skills に対する 許可リスト のブロックを含みます）。
- 要件は、各 `SKILL.md` 内の `metadata.openclaw.requires` から導出されます。

## インストール操作

- `metadata.openclaw.install` は、インストール オプション（brew/node/go/uv）を定義します。
- アプリは `skills.install` を呼び出し、ゲートウェイ ホスト 上でインストーラーを実行します。
- ゲートウェイ は、複数が提供されている場合でも、優先されるインストーラーを 1 つだけ公開します
  （利用可能な場合は brew、そうでない場合は `skills.install` の node マネージャー、既定は npm）。

## 環境変数 / API キー

- アプリは、`skills.entries.<skillKey> ` 配下の `~/.openclaw/openclaw.json` にキーを保存します。\`.
- `skills.update` は、`enabled`、`apiKey`、および `env` をパッチします。

## リモートモード

- インストールおよび設定の更新は、ローカルの Mac ではなく ゲートウェイ ホスト 上で行われます。
