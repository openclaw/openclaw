---
summary: "Gateway WebSocket プロトコル：ハンドシェイク、フレーム、バージョニング"
read_when:
  - Gateway WS クライアントを実装または更新する場合
  - プロトコルの不一致や接続失敗をデバッグする場合
  - プロトコルのスキーマ／モデルを再生成する場合
title: "Gateway プロトコル"
---

# Gateway プロトコル（WebSocket）

Gateway WS プロトコルは、OpenClaw の **単一のコントロールプレーン + ノード転送** です。すべてのクライアント（CLI、Web UI、macOS アプリ、iOS/Android ノード、ヘッドレス ノード）は WebSocket 経由で接続し、ハンドシェイク時に **role** と **scope** を宣言します。 すべてのクライアント（CLI、web UI、macOSアプリ、iOS/Androidノード、ヘッドレス
ノード）はWebSocket経由で接続し、
ハンドシェイク時間に**role** + **scope** を宣言します。

## トランスポート

- WebSocket、JSON ペイロードを含むテキスト フレーム。
- 最初のフレームは **必ず** `connect` のリクエストでなければなりません。

## ハンドシェイク（接続）

Gateway → クライアント（接続前チャレンジ）：

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

デバイス トークンが発行される場合、`hello-ok` には次も含まれます：

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

- **Request**：`{type:"req", id, method, params}`
- **Response**：`{type:"res", id, ok, payload|error}`
- **Event**：`{type:"event", event, payload, seq?, stateVersion?}`

副作用を伴うメソッドには **冪等性キー** が必要です（スキーマ参照）。

## ロール + スコープ

### ロール

- `operator` = コントロールプレーン クライアント（CLI/UI/自動化）。
- `node` = 機能ホスト（camera/screen/canvas/system.run）。

### スコープ（オペレーター）

一般的なスコープ：

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/コマンド/権限（ノード）

ノードは接続時に機能クレームを宣言します：

- `caps`：高レベルの機能カテゴリ。
- `commands`：invoke 用のコマンド許可リスト。
- `permissions`：粒度の細かいトグル（例：`screen.record`、`camera.capture`）。

Gateway はこれらを **クレーム** として扱い、サーバー側の許可リストを適用します。

## Presence

- `system-presence` は、デバイス アイデンティティをキーとするエントリを返します。
- プレゼンス エントリには `deviceId`、`roles`、`scopes` が含まれるため、**operator** と **node** の両方として接続している場合でも、UI はデバイスごとに 1 行で表示できます。

### ノード ヘルパー メソッド

- ノードは `skills.bins` を呼び出して、オート許可チェック用の現在の skill 実行ファイル一覧を取得できます。

## 実行承認

- 実行リクエストに承認が必要な場合、Gateway は `exec.approval.requested` をブロードキャストします。
- オペレーター クライアントは `exec.approval.resolve` を呼び出して解決します（`operator.approvals` スコープが必要）。

## Versioning

- `PROTOCOL_VERSION` は `src/gateway/protocol/schema.ts` にあります。
- クライアントは `minProtocol` と `maxProtocol` を送信し、サーバーは不一致を拒否します。
- スキーマとモデルは TypeBox 定義から生成されます：
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## 認証

- `OPENCLAW_GATEWAY_TOKEN`（または `--token`）が設定されている場合、`connect.params.auth.token` が一致しなければソケットはクローズされます。
- ペアリング後、ゲートウェイは接続
  ロール + スコープにスコープ付きの **デバイストークン** を発行します。 これは`hello-ok.auth.deviceToken` に返され、今後の接続のためにクライアントによって継続される
  である必要があります。
- デバイス トークンは `device.token.rotate` および `device.token.revoke` からローテーション／失効できます（`operator.pairing` スコープが必要）。

## デバイス アイデンティティ + ペアリング

- ノードは、鍵ペアのフィンガープリントから導出した安定したデバイス アイデンティティ（`device.id`）を含める必要があります。
- Gateway はデバイス + ロールごとにトークンを発行します。
- 新しいデバイス ID には、ローカル自動承認が有効でない限り、ペアリング承認が必要です。
- **ローカル** 接続には、ループバックおよび Gateway ホスト自身の tailnet アドレスが含まれます（同一ホストの tailnet バインドでも自動承認できるようにするため）。
- すべてのWSクライアントは、`connect` (演算子+ノード)中に`device` identityを含める必要があります。
  すべての WS クライアントは、`connect`（operator + node）中に `device` のアイデンティティを含める必要があります。
  コントロール UI は、`gateway.controlUi.allowInsecureAuth` が有効な場合に **のみ** 省略できます
  （またはブレークグラス用途として `gateway.controlUi.dangerouslyDisableDeviceAuth`）。
- 非ローカル接続は、サーバーが提供する `connect.challenge` の nonce に署名する必要があります。

## TLS + ピンニング

- WS 接続では TLS がサポートされています。
- クライアントは、Gateway の証明書フィンガープリントを任意でピン留めできます（`gateway.tls` の設定、ならびに `gateway.remote.tlsFingerprint` または CLI の `--tls-fingerprint` を参照）。

## スコープ

このプロトコルは **完全な Gateway API**（ステータス、チャンネル、モデル、チャット、エージェント、セッション、ノード、承認など）を公開します。正確な API サーフェスは、`src/gateway/protocol/schema.ts` にある TypeBox スキーマによって定義されています。 正確なサーフェスは `src/gateway/protocol/schema.ts` の
TypeBox スキーマによって定義されます。
