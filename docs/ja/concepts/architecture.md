---
summary: "WebSocket ゲートウェイのアーキテクチャ、コンポーネント、およびクライアントフロー"
read_when:
  - ゲートウェイプロトコル、クライアント、またはトランスポートに取り組んでいるとき
title: "Gateway アーキテクチャ"
x-i18n:
  source_path: concepts/architecture.md
  source_hash: 14079136faa267d7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:28Z
---

# Gateway アーキテクチャ

最終更新日: 2026-01-22

## 概要

- 単一の長時間稼働 **Gateway** が、すべてのメッセージングサーフェス（Baileys 経由の WhatsApp、grammY 経由の Telegram、Slack、Discord、Signal、iMessage、WebChat）を管理します。
- コントロールプレーンのクライアント（macOS アプリ、CLI、Web UI、自動化）は、設定されたバインドホスト（デフォルトは `127.0.0.1:18789`）上の **WebSocket** 経由で Gateway に接続します。
- **ノード**（macOS / iOS / Android / ヘッドレス）も **WebSocket** 経由で接続しますが、明示的な capabilities / コマンドを伴う `role: node` を宣言します。
- ホストあたり 1 つの Gateway とし、WhatsApp セッションを開くのはここだけです。
- **キャンバスホスト**（デフォルトは `18793`）は、エージェントが編集可能な HTML と A2UI を提供します。

## コンポーネントとフロー

### Gateway（デーモン）

- プロバイダー接続を維持します。
- 型付き WS API（リクエスト、レスポンス、サーバープッシュイベント）を公開します。
- 受信フレームを JSON Schema に対して検証します。
- `agent`、`chat`、`presence`、`health`、`heartbeat`、`cron` などのイベントを発行します。

### クライアント（mac アプリ / CLI / Web 管理）

- クライアントごとに 1 つの WS 接続。
- リクエストを送信します（`health`、`status`、`send`、`agent`、`system-presence`）。
- イベントを購読します（`tick`、`agent`、`presence`、`shutdown`）。

### ノード（macOS / iOS / Android / ヘッドレス）

- `role: node` を用いて **同一の WS サーバー** に接続します。
- `connect` にデバイスアイデンティティを提供します。ペアリングは **デバイスベース**（ロールは `node`）であり、承認はデバイスペアリングストアに保存されます。
- `canvas.*`、`camera.*`、`screen.record`、`location.get` などのコマンドを公開します。

プロトコルの詳細:

- [Gateway protocol](/gateway/protocol)

### WebChat

- Gateway WS API を使用してチャット履歴を取得し、送信を行う静的 UI です。
- リモート構成では、他のクライアントと同じ SSH / Tailscale トンネルを通じて接続します。

## 接続ライフサイクル（単一クライアント）

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## ワイヤープロトコル（概要）

- トランスポート: WebSocket、JSON ペイロードを含むテキストフレーム。
- 最初のフレームは **必ず** `connect` でなければなりません。
- ハンドシェイク後:
  - リクエスト: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - イベント: `{type:"event", event, payload, seq?, stateVersion?}`
- `OPENCLAW_GATEWAY_TOKEN`（または `--token`）が設定されている場合、`connect.params.auth.token` が一致しなければソケットはクローズされます。
- 副作用を伴うメソッド（`send`、`agent`）では、安全に再試行できるよう冪等性キーが必須です。サーバーは短命の重複排除キャッシュを保持します。
- ノードは `role: "node"` に加え、`connect` に capabilities / コマンド / 権限を含める必要があります。

## ペアリングとローカルトラスト

- すべての WS クライアント（オペレーター + ノード）は、`connect` に **デバイスアイデンティティ** を含めます。
- 新しいデバイス ID にはペアリング承認が必要です。Gateway は、以降の接続用に **デバイストークン** を発行します。
- **ローカル** 接続（ループバック、またはゲートウェイホスト自身の tailnet アドレス）は、同一ホストでの UX を円滑に保つため自動承認できます。
- **非ローカル** 接続は、`connect.challenge` の nonce に署名する必要があり、明示的な承認が必要です。
- Gateway 認証（`gateway.auth.*`）は、ローカル／リモートを問わず **すべて** の接続に適用されます。

詳細: [Gateway protocol](/gateway/protocol)、[Pairing](/channels/pairing)、[Security](/gateway/security)。

## プロトコルの型付けとコード生成

- TypeBox スキーマがプロトコルを定義します。
- それらのスキーマから JSON Schema が生成されます。
- JSON Schema から Swift モデルが生成されます。

## リモートアクセス

- 推奨: Tailscale または VPN。
- 代替: SSH トンネル

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- トンネル越しでも同一のハンドシェイク + 認証トークンが適用されます。
- リモート構成では、WS に対して TLS + 任意のピンニングを有効化できます。

## 運用スナップショット

- 起動: `openclaw gateway`（フォアグラウンド、ログは stdout に出力）。
- ヘルス: WS 経由の `health`（`hello-ok` にも含まれます）。
- 監督: 自動再起動のために launchd / systemd を使用します。

## 不変条件

- 各ホストにつき、単一の Baileys セッションを制御する Gateway は **正確に 1 つ** です。
- ハンドシェイクは必須です。JSON 以外、または connect 以外の最初のフレームは即時クローズされます。
- イベントは再送されません。欠落がある場合、クライアントは再取得する必要があります。
