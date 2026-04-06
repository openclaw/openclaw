---
read_when:
    - プロトコルスキーマやコード生成を更新する場合
summary: Gateway ゲートウェイプロトコルの単一の信頼できる情報源としてのTypeBoxスキーマ
title: TypeBox
x-i18n:
    generated_at: "2026-04-02T07:40:26Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 75755d442bbc53d14aa4ae35fc6fc0f38c2829393739fa97b318c233641efb9a
    source_path: concepts/typebox.md
    workflow: 15
---

# プロトコルの信頼できる情報源としてのTypeBox

最終更新日: 2026-01-10

TypeBoxはTypeScriptファーストのスキーマライブラリです。**Gateway ゲートウェイWebSocketプロトコル**（ハンドシェイク、リクエスト/レスポンス、サーバーイベント）の定義に使用しています。これらのスキーマが**ランタイムバリデーション**、**JSON Schemaエクスポート**、およびmacOSアプリ向けの**Swiftコード生成**を駆動します。単一の信頼できる情報源であり、それ以外はすべて生成されます。

より上位レベルのプロトコルコンテキストについては、[Gateway ゲートウェイアーキテクチャ](/concepts/architecture)を参照してください。

## メンタルモデル（30秒）

Gateway ゲートウェイのWSメッセージはすべて、以下の3種類のフレームのいずれかです：

- **リクエスト**: `{ type: "req", id, method, params }`
- **レスポンス**: `{ type: "res", id, ok, payload | error }`
- **イベント**: `{ type: "event", event, payload, seq?, stateVersion? }`

最初のフレームは**必ず** `connect` リクエストでなければなりません。その後、クライアントはメソッド（例: `health`、`send`、`chat.send`）を呼び出したり、イベント（例: `presence`、`tick`、`agent`）をサブスクライブしたりできます。

接続フロー（最小構成）：

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

主要なメソッドとイベント：

| カテゴリ    | 例                                                        | 備考                               |
| ----------- | --------------------------------------------------------- | ---------------------------------- |
| コア        | `connect`, `health`, `status`                             | `connect` が最初でなければならない  |
| メッセージ  | `send`, `poll`, `agent`, `agent.wait`                     | 副作用には `idempotencyKey` が必要  |
| チャット    | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChatが使用                      |
| セッション  | `sessions.list`, `sessions.patch`, `sessions.delete`      | セッション管理                     |
| ノード      | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway ゲートウェイWS + ノードアクション |
| イベント    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | サーバープッシュ                   |

正式な一覧は `src/gateway/server.ts`（`METHODS`、`EVENTS`）にあります。

## スキーマの配置場所

- ソース: `src/gateway/protocol/schema.ts`
- ランタイムバリデータ（AJV）: `src/gateway/protocol/index.ts`
- サーバーハンドシェイク + メソッドディスパッチ: `src/gateway/server.ts`
- ノードクライアント: `src/gateway/client.ts`
- 生成されたJSON Schema: `dist/protocol.schema.json`
- 生成されたSwiftモデル: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## 現在のパイプライン

- `pnpm protocol:gen`
  - JSON Schema（draft‑07）を `dist/protocol.schema.json` に出力
- `pnpm protocol:gen:swift`
  - SwiftのGateway ゲートウェイモデルを生成
- `pnpm protocol:check`
  - 両方のジェネレータを実行し、出力がコミットされていることを検証

## スキーマのランタイムでの使用方法

- **サーバー側**: すべての受信フレームはAJVでバリデーションされます。ハンドシェイクは `ConnectParams` に一致するパラメータを持つ `connect` リクエストのみを受け付けます。
- **クライアント側**: JSクライアントは、イベントおよびレスポンスフレームを使用する前にバリデーションします。
- **メソッドサーフェス**: Gateway ゲートウェイは `hello-ok` でサポートする `methods` と `events` をアドバタイズします。

## フレームの例

接続（最初のメッセージ）：

```json
{
  "type": "req",
  "id": "c1",
  "method": "connect",
  "params": {
    "minProtocol": 2,
    "maxProtocol": 2,
    "client": {
      "id": "openclaw-macos",
      "displayName": "macos",
      "version": "1.0.0",
      "platform": "macos 15.1",
      "mode": "ui",
      "instanceId": "A1B2"
    }
  }
}
```

Hello-okレスポンス：

```json
{
  "type": "res",
  "id": "c1",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 2,
    "server": { "version": "dev", "connId": "ws-1" },
    "features": { "methods": ["health"], "events": ["tick"] },
    "snapshot": {
      "presence": [],
      "health": {},
      "stateVersion": { "presence": 0, "health": 0 },
      "uptimeMs": 0
    },
    "policy": { "maxPayload": 1048576, "maxBufferedBytes": 1048576, "tickIntervalMs": 30000 }
  }
}
```

リクエスト + レスポンス：

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

イベント：

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## 最小クライアント（Node.js）

最小限の実用的なフロー: 接続 + ヘルスチェック。

```ts
import { WebSocket } from "ws";

const ws = new WebSocket("ws://127.0.0.1:18789");

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "req",
      id: "c1",
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "cli",
          displayName: "example",
          version: "dev",
          platform: "node",
          mode: "cli",
        },
      },
    }),
  );
});

ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type === "res" && msg.id === "c1" && msg.ok) {
    ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
  }
  if (msg.type === "res" && msg.id === "h1") {
    console.log("health:", msg.payload);
    ws.close();
  }
});
```

## 実践例: メソッドをエンドツーエンドで追加する

例: `{ ok: true, text }` を返す新しい `system.echo` リクエストを追加する。

1. **スキーマ（信頼できる情報源）**

`src/gateway/protocol/schema.ts` に追加：

```ts
export const SystemEchoParamsSchema = Type.Object(
  { text: NonEmptyString },
  { additionalProperties: false },
);

export const SystemEchoResultSchema = Type.Object(
  { ok: Type.Boolean(), text: NonEmptyString },
  { additionalProperties: false },
);
```

両方を `ProtocolSchemas` に追加し、型をエクスポート：

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **バリデーション**

`src/gateway/protocol/index.ts` でAJVバリデータをエクスポート：

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **サーバーの動作**

`src/gateway/server-methods/system.ts` にハンドラを追加：

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

`src/gateway/server-methods.ts` に登録し（既に `systemHandlers` をマージしている）、`src/gateway/server.ts` の `METHODS` に `"system.echo"` を追加します。

4. **再生成**

```bash
pnpm protocol:check
```

5. **テスト + ドキュメント**

`src/gateway/server.*.test.ts` にサーバーテストを追加し、ドキュメントにメソッドを記載します。

## Swiftコード生成の動作

Swiftジェネレータは以下を出力します：

- `req`、`res`、`event`、`unknown` ケースを持つ `GatewayFrame` enum
- 強く型付けされたペイロード構造体/enum
- `ErrorCode` 値と `GATEWAY_PROTOCOL_VERSION`

前方互換性のため、不明なフレームタイプは生のペイロードとして保持されます。

## バージョニング + 互換性

- `PROTOCOL_VERSION` は `src/gateway/protocol/schema.ts` にあります。
- クライアントは `minProtocol` + `maxProtocol` を送信し、サーバーは不一致を拒否します。
- Swiftモデルは古いクライアントが壊れないように、不明なフレームタイプを保持します。

## スキーマのパターンと規約

- ほとんどのオブジェクトは厳密なペイロードのために `additionalProperties: false` を使用します。
- `NonEmptyString` はIDおよびメソッド/イベント名のデフォルトです。
- トップレベルの `GatewayFrame` は `type` に対する**ディスクリミネータ**を使用します。
- 副作用を持つメソッドは通常、パラメータに `idempotencyKey` を必要とします（例: `send`、`poll`、`agent`、`chat.send`）。
- `agent` はランタイム生成のオーケストレーションコンテキスト（例: サブエージェント/cronタスク完了のハンドオフ）のためにオプショナルの `internalEvents` を受け付けます。これは内部APIサーフェスとして扱ってください。

## ライブスキーマJSON

生成されたJSON Schemaはリポジトリ内の `dist/protocol.schema.json` にあります。公開されている生ファイルは通常、以下のURLで利用可能です：

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## スキーマを変更する場合

1. TypeBoxスキーマを更新します。
2. `pnpm protocol:check` を実行します。
3. 再生成されたスキーマ + Swiftモデルをコミットします。
