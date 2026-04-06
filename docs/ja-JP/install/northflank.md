---
read_when:
  - NorthflankにOpenClawをデプロイする場合
  - ブラウザベースのControl UIでワンクリッククラウドデプロイを希望する場合
summary: "ワンクリックテンプレートでNorthflankにOpenClawをデプロイする"
title: "Northflank"
x-i18n:
  generated_at: "2026-04-03T00:00:00Z"
  model: claude-sonnet-4-6
  provider: anthropic
  source_hash: ""
  source_path: install/northflank.mdx
  workflow: 15
---

# Northflank

ワンクリックテンプレートを使用してNorthflankにOpenClawをデプロイし、ウェブControl UIからアクセスします。
これはサーバー上でターミナルを必要としない最も簡単なパスです: NorthflankがGateway ゲートウェイを実行します。

## 始め方

1. [Deploy OpenClaw](https://northflank.com/stacks/deploy-openclaw)をクリックしてテンプレートを開きます。
2. まだアカウントを持っていない場合は、[Northflankでアカウントを作成](https://app.northflank.com/signup)します。
3. **Deploy OpenClaw now**をクリックします。
4. 必須の環境変数を設定します: `OPENCLAW_GATEWAY_TOKEN`（強力なランダム値を使用してください）。
5. **Deploy stack**をクリックしてOpenClawテンプレートをビルドして実行します。
6. デプロイが完了するまで待ち、**View resources**をクリックします。
7. OpenClawサービスを開きます。
8. `/openclaw`のパブリックOpenClaw URLを開き、`OPENCLAW_GATEWAY_TOKEN`を使用して接続します。

## 提供されるもの

- ホスト型OpenClaw Gateway ゲートウェイ + Control UI
- Northflank Volume（`/data`）による永続ストレージ（再デプロイ後もconfig/credentials/workspaceが保持される）

## チャンネルを接続する

`/openclaw`のControl UIを使用するか、SSH経由で`openclaw onboard`を実行してチャンネル設定の手順を確認します:

- [Telegram](/channels/telegram)（最速 — ボットトークンのみ）
- [Discord](/channels/discord)
- [すべてのチャンネル](/channels)

## 次のステップ

- メッセージングチャンネルを設定する: [Channels](/channels)
- Gateway ゲートウェイを設定する: [Gateway ゲートウェイ設定](/gateway/configuration)
- OpenClawを最新の状態に保つ: [Updating](/install/updating)
