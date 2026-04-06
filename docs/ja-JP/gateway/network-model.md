---
read_when:
    - Gateway ゲートウェイのネットワークモデルの概要を知りたい場合
summary: Gateway ゲートウェイ、ノード、キャンバスホストの接続方法。
title: ネットワークモデル
x-i18n:
    generated_at: "2026-04-02T08:30:32Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 8f8227d0250b8fdcedaa96db101bbf1498bc860a6ce6528641888f9d9cf8e2ec
    source_path: gateway/network-model.md
    workflow: 15
---

# ネットワークモデル

> このコンテンツは[ネットワーク](/network#core-model)に統合されました。最新のガイドはそちらを参照してください。

ほとんどの操作は Gateway ゲートウェイ（`openclaw gateway`）を経由します。これはチャネル接続と WebSocket コントロールプレーンを管理する単一の長時間実行プロセスです。

## 基本ルール

- 1ホストにつき1つの Gateway ゲートウェイを推奨します。WhatsApp Web セッションを所有できるのはこのプロセスだけです。レスキューボットや厳密な分離が必要な場合は、プロファイルとポートを分離して複数の Gateway ゲートウェイを実行してください。[複数の Gateway ゲートウェイ](/gateway/multiple-gateways)を参照してください。
- ループバック優先: Gateway ゲートウェイの WS はデフォルトで `ws://127.0.0.1:18789` です。ウィザードはループバックの場合でもデフォルトで Gateway ゲートウェイトークンを生成します。tailnet アクセスの場合は、非ループバックバインドではトークンが必要なため、`openclaw gateway --bind tailnet --token ...` を実行してください。
- ノードは必要に応じて LAN、tailnet、または SSH 経由で Gateway ゲートウェイの WS に接続します。レガシー TCP ブリッジは非推奨です。
- キャンバスホストは Gateway ゲートウェイの HTTP サーバーにより、Gateway ゲートウェイと**同じポート**（デフォルト `18789`）で提供されます:
  - `/__openclaw__/canvas/`
  - `/__openclaw__/a2ui/`
    `gateway.auth` が設定されており、Gateway ゲートウェイがループバック以外にバインドされている場合、これらのルートは Gateway ゲートウェイ認証で保護されます。ノードクライアントは、アクティブな WS セッションに紐づくノードスコープのケイパビリティ URL を使用します。[Gateway ゲートウェイの設定](/gateway/configuration)（`canvasHost`、`gateway`）を参照してください。
- リモート利用は通常 SSH トンネルまたは tailnet VPN を使用します。[リモートアクセス](/gateway/remote)および[ディスカバリー](/gateway/discovery)を参照してください。
