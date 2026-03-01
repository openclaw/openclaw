---
summary: "Gateway、ノード、Canvasホストの接続方法"
read_when:
  - You want a concise view of the Gateway networking model
title: "ネットワークモデル"
---

ほとんどの操作はGateway（`openclaw gateway`）を経由します。これはチャンネル接続とWebSocketコントロールプレーンを所有する単一の常時稼働プロセスです。

## コアルール

- ホストごとに1つのGatewayが推奨されます。WhatsApp Webセッションを所有できるのはこのプロセスのみです。レスキューボットや厳密な分離のために、分離されたプロファイルとポートで複数のGatewayを実行できます。[複数のGateway](/gateway/multiple-gateways)を参照してください。
- ループバックファースト：Gateway WSのデフォルトは`ws://127.0.0.1:18789`です。ウィザードはループバックの場合でもデフォルトでGatewayトークンを生成します。Tailnetアクセスの場合は、非ループバックバインドにはトークンが必要なため、`openclaw gateway --bind tailnet --token ...`を実行してください。
- ノードはLAN、Tailnet、または必要に応じてSSH経由でGateway WSに接続します。レガシーTCPブリッジは非推奨です。
- CanvasホストはGatewayと**同じポート**（デフォルト`18789`）のGateway HTTPサーバーで提供されます：
  - `/__openclaw__/canvas/`
  - `/__openclaw__/a2ui/`
    `gateway.auth`が設定され、Gatewayがループバック以外にバインドされている場合、これらのルートはGateway認証で保護されます。ノードクライアントはアクティブなWSセッションに紐付けられたノードスコープのケイパビリティURLを使用します。[Gateway設定](/gateway/configuration)（`canvasHost`、`gateway`）を参照してください。
- リモート使用は通常SSHトンネルまたはTailnet VPNです。[リモートアクセス](/gateway/remote)と[ディスカバリー](/gateway/discovery)を参照してください。
