---
summary: "Gateway ダッシュボード（Control UI）のアクセスと認証"
read_when:
  - ダッシュボードの認証や公開モードを変更する場合
title: "ダッシュボード"
x-i18n:
  source_path: web/dashboard.md
  source_hash: e4fc372b72f030f9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:37Z
---

# Dashboard（Control UI）

Gateway ダッシュボードは、既定では `/` で提供されるブラウザ向け Control UI です
（`gateway.controlUi.basePath` で上書きできます）。

クイックオープン（ローカルの Gateway）:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/)（または [http://localhost:18789/](http://localhost:18789/)）

主要な参照先:

- 使い方や UI の機能については [Control UI](/web/control-ui) を参照してください。
- Serve／Funnel の自動化については [Tailscale](/gateway/tailscale) を参照してください。
- バインドモードやセキュリティに関する注意点については [Web surfaces](/web) を参照してください。

認証は WebSocket ハンドシェイク時に `connect.params.auth`（トークンまたはパスワード）によって強制されます。
[Gateway configuration](/gateway/configuration) の `gateway.auth` を参照してください。

セキュリティ上の注意: Control UI は **管理者向けの画面**（チャット、設定、実行承認）です。
公開インターネットに公開しないでください。UI は初回読み込み後、トークンを `localStorage` に保存します。
localhost、Tailscale Serve、または SSH トンネルの使用を推奨します。

## Fast path（推奨）

- オンボーディング後、CLI はダッシュボードを自動的に開き、クリーン（トークンなし）のリンクを表示します。
- いつでも再オープンできます: `openclaw dashboard`（リンクをコピーし、可能であればブラウザを開き、ヘッドレスの場合は SSH のヒントを表示します）。
- UI で認証を求められた場合は、`gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）のトークンを Control UI の設定に貼り付けてください。

## トークンの基本（ローカルとリモート）

- **Localhost**: `http://127.0.0.1:18789/` を開きます。
- **トークンの取得元**: `gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）。接続後、UI は localStorage にコピーを保存します。
- **Localhost 以外**: Tailscale Serve（`gateway.auth.allowTailscale: true` の場合はトークン不要）、トークン付きの tailnet バインド、または SSH トンネルを使用してください。詳細は [Web surfaces](/web) を参照してください。

## 「unauthorized」／1008 が表示される場合

- ゲートウェイに到達可能であることを確認してください（ローカル: `openclaw status`。リモート: SSH トンネル `ssh -N -L 18789:127.0.0.1:18789 user@host` を張り、次に `http://127.0.0.1:18789/` を開きます）。
- ゲートウェイ ホストからトークンを取得してください: `openclaw config get gateway.auth.token`（または生成: `openclaw doctor --generate-gateway-token`）。
- ダッシュボードの設定で、認証フィールドにトークンを貼り付けてから接続してください。
