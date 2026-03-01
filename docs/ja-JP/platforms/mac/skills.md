---
summary: "macOS Skillsの設定UIとGatewayベースのステータス"
read_when:
  - macOS Skills設定UIの更新
  - スキルのゲーティングやインストール動作の変更
title: "Skills"
---

# Skills（macOS）

macOSアプリはGateway経由でOpenClaw Skillsを表示します。ローカルでスキルをパースすることはありません。

## データソース

- `skills.status`（Gateway）は、すべてのスキルとその適格性および不足している要件（バンドルスキルの許可リストブロックを含む）を返します。
- 要件は各`SKILL.md`の`metadata.openclaw.requires`から導出されます。

## インストールアクション

- `metadata.openclaw.install`はインストールオプション（brew/node/go/uv）を定義します。
- アプリはGatewayホストでインストーラーを実行するために`skills.install`を呼び出します。
- 複数が提供されている場合、Gatewayは優先する1つのインストーラーのみを表示します（利用可能な場合はbrew、そうでなければ`skills.install`のノードマネージャー、デフォルトはnpm）。

## 環境変数/APIキー

- アプリはキーを`~/.openclaw/openclaw.json`の`skills.entries.<skillKey>`に保存します。
- `skills.update`で`enabled`、`apiKey`、`env`をパッチします。

## リモートモード

- インストール + 設定更新はGatewayホスト（ローカルMacではなく）で実行されます。
