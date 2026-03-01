---
summary: "Bridgeプロトコル（レガシーノード）：TCP JSONL、ペアリング、スコープ付きRPC"
read_when:
  - Building or debugging node clients (iOS/Android/macOS node mode)
  - Investigating pairing or bridge auth failures
  - Auditing the node surface exposed by the gateway
title: "Bridgeプロトコル"
---

# Bridgeプロトコル（レガシーノードトランスポート）

Bridgeプロトコルは**レガシー**のノードトランスポート（TCP JSONL）です。新しいノードクライアントは、代わりに統一Gateway WebSocketプロトコルを使用してください。

オペレーターまたはノードクライアントを構築する場合は、[Gatewayプロトコル](/gateway/protocol)を使用してください。

**注意：**現在のOpenClawビルドはTCPブリッジリスナーを同梱していません。このドキュメントは歴史的な参照として保持されています。
レガシーの`bridge.*`設定キーは設定スキーマの一部ではなくなりました。

## 両方がある理由

- **セキュリティ境界**：Bridgeは完全なGateway APIサーフェスの代わりに小さな許可リストを公開します。
- **ペアリング + ノードID**：ノードのアドミッションはGatewayが所有し、ノードごとのトークンに紐づけられます。
- **ディスカバリーUX**：ノードはLAN上のBonjourでGatewayを検出したり、Tailnet経由で直接接続したりできます。
- **ループバックWS**：完全なWSコントロールプレーンは、SSH経由でトンネルしない限りローカルのままです。

## トランスポート

- TCP、1行に1つのJSONオブジェクト（JSONL）。
- オプションのTLS（`bridge.tls.enabled`がtrueの場合）。
- レガシーのデフォルトリスナーポートは`18790`でした（現在のビルドではTCPブリッジは開始されません）。

TLSが有効な場合、ディスカバリーTXTレコードには`bridgeTls=1`と非シークレットヒントとしての`bridgeTlsSha256`が含まれます。Bonjour/mDNS TXTレコードは認証されていないため、明示的なユーザーの意図やその他のアウトオブバンド検証なしに、アドバタイズされたフィンガープリントを権威あるピンとしてクライアントが扱ってはいけません。

## ハンドシェイク + ペアリング

1. クライアントがノードメタデータ + トークン（既にペアリング済みの場合）を含む`hello`を送信します。
2. ペアリングされていない場合、Gatewayは`error`（`NOT_PAIRED`/`UNAUTHORIZED`）で応答します。
3. クライアントが`pair-request`を送信します。
4. Gatewayが承認を待ち、`pair-ok`と`hello-ok`を送信します。

`hello-ok`は`serverName`を返し、`canvasHostUrl`を含む場合があります。

## フレーム

クライアント → Gateway：

- `req` / `res`：スコープ付きGateway RPC（chat、sessions、config、health、voicewake、skills.bins）
- `event`：ノードシグナル（音声トランスクリプト、エージェントリクエスト、チャットサブスクライブ、execライフサイクル）

Gateway → クライアント：

- `invoke` / `invoke-res`：ノードコマンド（`canvas.*`、`camera.*`、`screen.record`、`location.get`、`sms.send`）
- `event`：サブスクライブされたセッションのチャット更新
- `ping` / `pong`：キープアライブ

レガシーの許可リスト強制は`src/gateway/server-bridge.ts`にありました（削除済み）。

## Execライフサイクルイベント

ノードは`exec.finished`または`exec.denied`イベントを発行して、system.runアクティビティを表示できます。これらはGatewayのシステムイベントにマッピングされます（レガシーノードは引き続き`exec.started`を発行する場合があります）。

ペイロードフィールド（特に記載がない限りすべてオプション）：

- `sessionKey`（必須）：システムイベントを受信するエージェントセッション。
- `runId`：グループ化のための一意のexec ID。
- `command`：生またはフォーマットされたコマンド文字列。
- `exitCode`、`timedOut`、`success`、`output`：完了の詳細（finishedのみ）。
- `reason`：拒否理由（deniedのみ）。

## Tailnetの使用

- ブリッジをTailnet IPにバインド：`~/.openclaw/openclaw.json`で`bridge.bind: "tailnet"`を設定します。
- クライアントはMagicDNS名またはTailnet IP経由で接続します。
- Bonjourはネットワークを**越えません**。必要に応じて手動のhost/portまたはWide-Area DNS-SDを使用してください。

## バージョニング

Bridgeは現在**暗黙のv1**です（min/maxネゴシエーションなし）。後方互換性が期待されます。破壊的変更の前にBridgeプロトコルバージョンフィールドを追加してください。
