---
summary: "Gateway ダッシュボード（コントロール UI）のアクセスと認証"
read_when:
  - ダッシュボードの認証や公開モードを変更する場合
title: "ダッシュボード"
---

# ダッシュボード（コントロール UI）

Gateway ダッシュボードは、デフォルトで `/` に配信されるブラウザ用のコントロール UI です
（`gateway.controlUi.basePath` でオーバーライドできます）。

クイックオープン（ローカル Gateway）:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/)（または [http://localhost:18789/](http://localhost:18789/)）

主要なリファレンス:

- 使用方法と UI の機能については [コントロール UI](/web/control-ui) を参照してください。
- Serve/Funnel の自動化については [Tailscale](/gateway/tailscale) を参照してください。
- バインドモードとセキュリティの注意事項については [Web サーフェス](/web) を参照してください。

認証は `connect.params.auth`（トークンまたはパスワード）を通じて WebSocket ハンドシェイク時に強制されます。[Gateway 設定](/gateway/configuration) の `gateway.auth` を参照してください。

セキュリティに関する注意: コントロール UI は**管理サーフェス**です（チャット、設定、exec 承認）。公開しないでください。UI は初回ロード後にトークンを `localStorage` に保存します。ローカルホスト、Tailscale Serve、または SSH トンネルを優先してください。

## ファストパス（推奨）

- オンボーディング後、CLI はダッシュボードを自動的に開き、クリーンな（トークンなしの）リンクを表示します。
- いつでも再度開く: `openclaw dashboard`（リンクをコピーし、可能であればブラウザを開きます。ヘッドレスの場合は SSH ヒントを表示します）。
- UI が認証を求める場合は、`gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）のトークンをコントロール UI の設定に貼り付けてください。

## トークンの基本（ローカル vs リモート）

- **ローカルホスト**: `http://127.0.0.1:18789/` を開きます。
- **トークンの取得元**: `gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）。接続後、UI が localStorage にコピーを保存します。
- **ローカルホスト以外**: Tailscale Serve（`gateway.auth.allowTailscale: true` の場合、コントロール UI/WebSocket はトークンなしで認証可能。Gateway ホストが信頼されていることが前提。HTTP API は引き続きトークン/パスワードが必要）、Tailnet バインドとトークン、または SSH トンネルを使用してください。[Web サーフェス](/web) を参照してください。

## 「unauthorized」/ 1008 が表示される場合

- Gateway に到達できることを確認してください（ローカル: `openclaw status`; リモート: SSH トンネル `ssh -N -L 18789:127.0.0.1:18789 user@host` を使用して `http://127.0.0.1:18789/` を開く）。
- Gateway ホストからトークンを取得: `openclaw config get gateway.auth.token`（または生成: `openclaw doctor --generate-gateway-token`）。
- ダッシュボードの設定で、認証フィールドにトークンを貼り付けてから接続してください。
