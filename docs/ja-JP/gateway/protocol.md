---
summary: "Gateway WebSocketプロトコル：ハンドシェイク、フレーム、バージョニング"
read_when:
  - Implementing or updating gateway WS clients
  - Debugging protocol mismatches or connect failures
  - Regenerating protocol schema/models
title: "Gatewayプロトコル"
---

# Gatewayプロトコル（WebSocket）

Gateway WSプロトコルはOpenClawの**単一のコントロールプレーン + ノードトランスポート**です。すべてのクライアント（CLI、Web UI、macOSアプリ、iOS/Androidノード、ヘッドレスノード）はWebSocketで接続し、ハンドシェイク時に**ロール** + **スコープ**を宣言します。

## トランスポート

- WebSocket、JSONペイロードのテキストフレーム。
- 最初のフレームは`connect`リクエストで**なければなりません**。

## ハンドシェイク（connect）

Gateway → クライアント（プリコネクトチャレンジ）：

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

クライアント → Gateway：

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Gateway → クライアント：

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

デバイストークンが発行された場合、`hello-ok`には以下も含まれます：

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### ノードの例

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## フレーミング

- **リクエスト**：`{type:"req", id, method, params}`
- **レスポンス**：`{type:"res", id, ok, payload|error}`
- **イベント**：`{type:"event", event, payload, seq?, stateVersion?}`

副作用のあるメソッドには**べき等キー**が必要です（スキーマを参照）。

## ロール + スコープ

### ロール

- `operator` = コントロールプレーンクライアント（CLI/UI/オートメーション）。
- `node` = ケイパビリティホスト（カメラ/スクリーン/Canvas/system.run）。

### スコープ（operator）

一般的なスコープ：

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/commands/permissions（node）

ノードはconnect時にケイパビリティクレームを宣言します：

- `caps`：高レベルのケイパビリティカテゴリ。
- `commands`：invoke用のコマンド許可リスト。
- `permissions`：きめ細かなトグル（例：`screen.record`、`camera.capture`）。

Gatewayはこれらを**クレーム**として扱い、サーバーサイドの許可リストを適用します。

## プレゼンス

- `system-presence`はデバイスアイデンティティでキーイングされたエントリを返します。
- プレゼンスエントリには`deviceId`、`roles`、`scopes`が含まれるため、UIはデバイスが**operator**と**node**の両方として接続している場合でも、デバイスごとに1行を表示できます。

### ノードヘルパーメソッド

- ノードは`skills.bins`を呼び出して、自動許可チェック用のスキル実行ファイルの現在のリストを取得できます。

### オペレーターヘルパーメソッド

- オペレーターは`tools.catalog`（`operator.read`）を呼び出して、エージェントのランタイムツールカタログを取得できます。レスポンスにはグループ化されたツールとプロヴェナンスメタデータが含まれます：
  - `source`：`core`または`plugin`
  - `pluginId`：`source="plugin"`の場合のプラグインオーナー
  - `optional`：プラグインツールがオプションかどうか

## Exec承認

- execリクエストが承認を必要とする場合、Gatewayは`exec.approval.requested`をブロードキャストします。
- オペレータークライアントは`exec.approval.resolve`を呼び出して解決します（`operator.approvals`スコープが必要）。

## バージョニング

- `PROTOCOL_VERSION`は`src/gateway/protocol/schema.ts`にあります。
- クライアントは`minProtocol` + `maxProtocol`を送信します。サーバーは不一致を拒否します。
- スキーマ + モデルはTypeBox定義から生成されます：
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## 認証

- `OPENCLAW_GATEWAY_TOKEN`（または`--token`）が設定されている場合、`connect.params.auth.token`が一致するか、ソケットが閉じられます。
- ペアリング後、Gatewayは接続ロール + スコープにスコープされた**デバイストークン**を発行します。`hello-ok.auth.deviceToken`で返され、クライアントは将来のconnect用に永続化する必要があります。
- デバイストークンは`device.token.rotate`と`device.token.revoke`で回転/失効できます（`operator.pairing`スコープが必要）。

## デバイスアイデンティティ + ペアリング

- ノードはキーペアフィンガープリントから派生した安定したデバイスアイデンティティ（`device.id`）を含める必要があります。
- Gatewayはデバイス + ロールごとにトークンを発行します。
- ローカル自動承認が有効でない限り、新しいデバイスIDにはペアリング承認が必要です。
- **ローカル**接続にはループバックとGatewayホスト自身のTailnetアドレスが含まれます（同じホストのTailnetバインドでも自動承認が可能）。
- すべてのWSクライアントは`connect`時に`device`アイデンティティを含める必要があります（operator + node）。
  Control UIは`gateway.controlUi.dangerouslyDisableDeviceAuth`がブレイクグラス用に有効になっている場合**のみ**省略できます。
- すべての接続はサーバー提供の`connect.challenge`ノンスに署名する必要があります。

### デバイス認証マイグレーション診断

チャレンジ署名前の動作をまだ使用しているレガシークライアントの場合、`connect`は`error.details.code`配下に`DEVICE_AUTH_*`詳細コードと安定した`error.details.reason`を返すようになりました。

一般的なマイグレーション失敗：

| メッセージ                     | details.code                     | details.reason           | 意味                                            |
| --------------------------- | -------------------------------- | ------------------------ | -------------------------------------------------- |
| `device nonce required`     | `DEVICE_AUTH_NONCE_REQUIRED`     | `device-nonce-missing`   | クライアントが`device.nonce`を省略（または空白を送信）。     |
| `device nonce mismatch`     | `DEVICE_AUTH_NONCE_MISMATCH`     | `device-nonce-mismatch`  | クライアントが古い/間違ったノンスで署名。            |
| `device signature invalid`  | `DEVICE_AUTH_SIGNATURE_INVALID`  | `device-signature`       | 署名ペイロードがv2ペイロードと一致しない。       |
| `device signature expired`  | `DEVICE_AUTH_SIGNATURE_EXPIRED`  | `device-signature-stale` | 署名されたタイムスタンプが許容スキュー外。          |
| `device identity mismatch`  | `DEVICE_AUTH_DEVICE_ID_MISMATCH` | `device-id-mismatch`     | `device.id`が公開鍵フィンガープリントと一致しない。 |
| `device public key invalid` | `DEVICE_AUTH_PUBLIC_KEY_INVALID` | `device-public-key`      | 公開鍵の形式/正規化が失敗。         |

マイグレーションターゲット：

- 常に`connect.challenge`を待ちます。
- サーバーノンスを含むv2ペイロードに署名します。
- `connect.params.device.nonce`に同じノンスを送信します。
- 推奨署名ペイロードは`v3`で、デバイス/クライアント/ロール/スコープ/トークン/ノンスフィールドに加えて`platform`と`deviceFamily`をバインドします。
- レガシーの`v2`署名は互換性のために引き続き受け入れられますが、ペアリング済みデバイスのメタデータピンニングは再接続時のコマンドポリシーを制御します。

## TLS + ピンニング

- WS接続でTLSがサポートされています。
- クライアントはオプションでGateway証明書フィンガープリントをピンできます（`gateway.tls`設定と`gateway.remote.tlsFingerprint`またはCLI`--tls-fingerprint`を参照）。

## スコープ

このプロトコルは**完全なGateway API**（ステータス、チャンネル、モデル、チャット、エージェント、セッション、ノード、承認など）を公開します。正確なサーフェスは`src/gateway/protocol/schema.ts`のTypeBoxスキーマで定義されています。
