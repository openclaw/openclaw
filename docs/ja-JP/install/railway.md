---
read_when:
  - RailwayにOpenClawをデプロイする場合
  - ブラウザベースのControl UIでワンクリッククラウドデプロイを希望する場合
summary: "ワンクリックテンプレートでRailwayにOpenClawをデプロイする"
title: "Railway"
x-i18n:
  generated_at: "2026-04-03T00:00:00Z"
  model: claude-sonnet-4-6
  provider: anthropic
  source_hash: ""
  source_path: install/railway.mdx
  workflow: 15
---

# Railway

ワンクリックテンプレートを使用してRailwayにOpenClawをデプロイし、ウェブControl UIからアクセスします。
これはサーバー上でターミナルを必要としない最も簡単なパスです: RailwayがGateway ゲートウェイを実行します。

## クイックチェックリスト（新規ユーザー）

1. **Deploy on Railway**（下記）をクリックします。
2. `/data`にマウントされた**Volume**を追加します。
3. 必須の**Variables**を設定します（少なくとも`OPENCLAW_GATEWAY_PORT`と`OPENCLAW_GATEWAY_TOKEN`）。
4. ポート`8080`で**HTTP Proxy**を有効にします。
5. `https://<your-railway-domain>/openclaw`を開き、`OPENCLAW_GATEWAY_TOKEN`を使用して接続します。

## ワンクリックデプロイ

<a href="https://railway.com/deploy/clawdbot-railway-template" target="_blank" rel="noreferrer">
  Deploy on Railway
</a>

デプロイ後、**Railway → サービス → Settings → Domains**でパブリックURLを確認します。

Railwayは以下のいずれかを提供します:

- 生成されたドメイン（例: `https://<something>.up.railway.app`）、または
- カスタムドメインを添付した場合はそのドメイン

次のURLを開きます:

- `https://<your-railway-domain>/openclaw` — Control UI

## 提供されるもの

- ホスト型OpenClaw Gateway ゲートウェイ + Control UI
- Railway Volume（`/data`）による永続ストレージ（再デプロイ後もconfig/credentials/workspaceが保持される）

## 必須のRailway設定

### パブリックネットワーキング

サービスの**HTTP Proxy**を有効にします。

- ポート: `8080`

### Volume（必須）

以下にマウントされたVolumeを追加します:

- `/data`

### Variables

サービスに以下の変数を設定します:

- `OPENCLAW_GATEWAY_PORT=8080`（必須 — パブリックネットワーキングのポートと一致する必要があります）
- `OPENCLAW_GATEWAY_TOKEN`（必須; 管理者シークレットとして扱ってください）
- `OPENCLAW_STATE_DIR=/data/.openclaw`（推奨）
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`（推奨）

## チャンネルを接続する

`/openclaw`のControl UIを使用するか、Railwayのシェルから`openclaw onboard`を実行してチャンネル設定の手順を確認します:

- [Telegram](/channels/telegram)（最速 — ボットトークンのみ）
- [Discord](/channels/discord)
- [すべてのチャンネル](/channels)

## バックアップと移行

設定とworkspaceをエクスポートします:

```bash
openclaw backup create
```

これにより、任意のOpenClawホストで復元できるポータブルなバックアップアーカイブが作成されます。詳細は[Backup](/cli/backup)を参照してください。

## 次のステップ

- メッセージングチャンネルを設定する: [Channels](/channels)
- Gateway ゲートウェイを設定する: [Gateway ゲートウェイ設定](/gateway/configuration)
- OpenClawを最新の状態に保つ: [Updating](/install/updating)
