---
summary: "Gateway（ゲートウェイ）、ノード、キャンバスホストがどのように接続されるか。"
read_when:
  - Gateway のネットワークモデルを簡潔に把握したい場合
title: "ネットワークモデル"
x-i18n:
  source_path: gateway/network-model.md
  source_hash: e3508b884757ef19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:52Z
---

ほとんどの操作は Gateway（ゲートウェイ）（`openclaw gateway`）を経由します。これは、チャンネル接続と WebSocket 制御プレーンを所有する、単一の長時間稼働プロセスです。

## 基本ルール

- ホストあたり 1 つの Gateway を推奨します。WhatsApp Web セッションを所有できるのは、このプロセスのみです。レスキューボットや厳密な分離が必要な場合は、分離されたプロファイルとポートで複数のゲートウェイを実行してください。詳細は [Multiple gateways](/gateway/multiple-gateways) を参照してください。
- ループバック優先: Gateway の WS は既定で `ws://127.0.0.1:18789` です。ウィザードは、ループバックの場合でも既定でゲートウェイトークンを生成します。tailnet アクセスでは、非ループバックのバインドにはトークンが必要なため、`openclaw gateway --bind tailnet --token ...` を実行してください。
- ノードは、必要に応じて LAN、tailnet、または SSH 経由で Gateway の WS に接続します。レガシー TCP ブリッジは非推奨です。
- キャンバスホストは、`canvasHost.port`（既定 `18793`）上の HTTP ファイルサーバーで、ノードの WebView 向けに `/__openclaw__/canvas/` を提供します。詳細は [Gateway configuration](/gateway/configuration)（`canvasHost`）を参照してください。
- リモート利用は、通常、SSH トンネルまたは tailnet VPN を使用します。[Remote access](/gateway/remote) と [Discovery](/gateway/discovery) を参照してください。
