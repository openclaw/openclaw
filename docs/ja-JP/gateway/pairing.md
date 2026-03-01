---
summary: "iOSおよびその他のリモートノード向けのGateway所有ノードペアリング（オプションB）"
read_when:
  - Implementing node pairing approvals without macOS UI
  - Adding CLI flows for approving remote nodes
  - Extending gateway protocol with node management
title: "Gateway所有ペアリング"
---

# Gateway所有ペアリング（オプションB）

Gateway所有ペアリングでは、**Gateway**がどのノードの参加を許可するかの真のソースです。UI（macOSアプリ、将来のクライアント）は、保留中のリクエストを承認または拒否するフロントエンドに過ぎません。

**重要：** WSノードは`connect`時に**デバイスペアリング**（ロール`node`）を使用します。
`node.pair.*`は別のペアリングストアであり、WSハンドシェイクをゲートする**わけではありません**。
明示的に`node.pair.*`を呼び出すクライアントのみがこのフローを使用します。

## コンセプト

- **保留中のリクエスト**：ノードが参加を要求しました。承認が必要です。
- **ペアリング済みノード**：発行された認証トークンを持つ承認済みノード。
- **トランスポート**：Gateway WSエンドポイントはリクエストを転送しますが、メンバーシップを決定しません。（レガシーTCPブリッジサポートは非推奨/削除されています。）

## ペアリングの仕組み

1. ノードがGateway WSに接続し、ペアリングをリクエストします。
2. Gatewayが**保留中のリクエスト**を保存し、`node.pair.requested`を発行します。
3. リクエストを承認または拒否します（CLIまたはUI）。
4. 承認時、Gatewayが**新しいトークン**を発行します（再ペアリング時にトークンがローテーションされます）。
5. ノードがトークンを使用して再接続し、「ペアリング済み」になります。

保留中のリクエストは**5分**後に自動的に期限切れになります。

## CLIワークフロー（ヘッドレスフレンドリー）

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status`はペアリング済み/接続済みのノードとそのケイパビリティを表示します。

## APIサーフェス（Gatewayプロトコル）

イベント：

- `node.pair.requested` — 新しい保留中のリクエストが作成されたときに発行されます。
- `node.pair.resolved` — リクエストが承認/拒否/期限切れになったときに発行されます。

メソッド：

- `node.pair.request` — 保留中のリクエストを作成または再利用します。
- `node.pair.list` — 保留中 + ペアリング済みのノードを一覧表示します。
- `node.pair.approve` — 保留中のリクエストを承認します（トークンを発行）。
- `node.pair.reject` — 保留中のリクエストを拒否します。
- `node.pair.verify` — `{ nodeId, token }`を検証します。

注意：

- `node.pair.request`はノードごとにべき等です：繰り返しの呼び出しは同じ保留中のリクエストを返します。
- 承認は**常に**新しいトークンを生成します。`node.pair.request`からトークンが返されることはありません。
- リクエストには自動承認フローのヒントとして`silent: true`を含めることができます。

## 自動承認（macOSアプリ）

macOSアプリは以下の条件でオプションの**サイレント承認**を試みることができます：

- リクエストが`silent`としてマークされている場合、および
- アプリが同じユーザーを使用してGatewayホストへのSSH接続を検証できる場合。

サイレント承認が失敗した場合、通常の「承認/拒否」プロンプトにフォールバックします。

## ストレージ（ローカル、プライベート）

ペアリング状態はGateway状態ディレクトリ（デフォルト`~/.openclaw`）配下に保存されます：

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

`OPENCLAW_STATE_DIR`をオーバーライドすると、`nodes/`フォルダーもそれに従って移動します。

セキュリティに関する注意：

- トークンはシークレットです。`paired.json`を機密として扱ってください。
- トークンのローテーションには再承認（またはノードエントリの削除）が必要です。

## トランスポートの動作

- トランスポートは**ステートレス**です。メンバーシップを保存しません。
- Gatewayがオフラインまたはペアリングが無効な場合、ノードはペアリングできません。
- Gatewayがリモートモードの場合でも、ペアリングはリモートGatewayのストアに対して行われます。
