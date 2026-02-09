---
summary: "Gateway（ゲートウェイ）、ノード、キャンバスホストがどのように接続されるか。"
read_when:
  - Gateway のネットワークモデルを簡潔に把握したい場合
title: "ネットワークモデル"
---

ほとんどの操作は Gateway（ゲートウェイ）（`openclaw gateway`）を経由します。これは、チャンネル接続と WebSocket 制御プレーンを所有する、単一の長時間稼働プロセスです。

## 基本ルール

- ホストごとに1つのゲートウェイを推奨します。 それはのWhatsAppのWebセッションを所有することができる唯一のプロセスです。 レスキューボットまたは厳密な隔離のために、分離されたプロファイルとポートを持つ複数のゲートウェイを実行します。 [Multiple gateways](/gateway/multiple-gateways) を参照してください。
- ループバック優先: Gateway の WS は既定で `ws://127.0.0.1:18789` です。ウィザードは、ループバックの場合でも既定でゲートウェイトークンを生成します。tailnet アクセスでは、非ループバックのバインドにはトークンが必要なため、`openclaw gateway --bind tailnet --token ...` を実行してください。 ウィザードは、ループバックであっても、デフォルトでゲートウェイ トークンを生成します。 tailnet アクセスを行うには、 `openclaw gateway --bind tailnet --token ...` を実行してください。なぜならトークンは非ループバックバインディングに必要だからです。
- ノードは、必要に応じて LAN、tailnet、または SSH 経由で Gateway の WS に接続します。レガシー TCP ブリッジは非推奨です。 従来の TCP ブリッジは非推奨です。
- キャンバスホストは、`canvasHost.port`（既定 `18793`）上の HTTP ファイルサーバーで、ノードの WebView 向けに `/__openclaw__/canvas/` を提供します。詳細は [Gateway configuration](/gateway/configuration)（`canvasHost`）を参照してください。 [Gateway configuration](/gateway/configuration) (`canvasHost` ) を参照してください。
- リモート利用は、通常、SSH トンネルまたは tailnet VPN を使用します。[Remote access](/gateway/remote) と [Discovery](/gateway/discovery) を参照してください。 [リモート アクセス](/gateway/remote) と [Discovery](/gateway/discovery) を参照してください。
