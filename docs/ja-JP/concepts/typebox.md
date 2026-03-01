---
summary: "Gateway プロトコルの唯一の情報源としての TypeBox スキーマ"
read_when:
  - プロトコルスキーマまたはコード生成を更新しているとき
title: "TypeBox"
---

# プロトコルの情報源としての TypeBox

最終更新: 2026-01-10

TypeBox は TypeScript ファーストのスキーマライブラリです。**Gateway WebSocket プロトコル**（ハンドシェイク、リクエスト/レスポンス、サーバーイベント）の定義に使用します。これらのスキーマが**ランタイム検証**、**JSON Schema エクスポート**、macOS アプリ向けの **Swift コード生成**を担います。唯一の情報源であり、他はすべて生成されます。

上位レベルのプロトコルコンテキストについては、まず[Gateway アーキテクチャ](/concepts/architecture)を参照してください。

## メンタルモデル（30 秒）

すべての Gateway WebSocket メッセージは以下の 3 種類のフレームのいずれかです。

- **リクエスト**: `{ type: "req", id, method, params }`
- **レスポンス**: `{ type: "res", id, ok, payload | error }`
- **イベント**: `{ type: "event", event, payload, seq?, stateVersion? }`

最初のフレームは必ず `connect` リクエストでなければなりません。その後、クライアントはメソッドを呼び出し（例: `health`、`send`、`chat.send`）、イベントを購読できます（例: `presence`、`tick`、`agent`）。

接続フロー（最小）:

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

一般的なメソッドとイベント:

| カテゴリ | 例 | 注意 |
| --------- | --------------------------------------------------------- | ---------------------------------- |
| コア | `connect`、`health`、`status` | `connect` を最初に |
| メッセージング | `send`、`poll`、`agent`、`agent.wait` | 副作用には `idempotencyKey` が必要 |
| チャット | `chat.history`、`chat.send`、`chat.abort`、`chat.inject` | WebChat が使用 |
| セッション | `sessions.list`、`sessions.patch`、`sessions.delete` | セッション管理 |
| ノード | `node.list`、`node.invoke`、`node.pair.*` | Gateway WebSocket + ノードアクション |
| イベント | `tick`、`presence`、`agent`、`chat`、`health`、`shutdown` | サーバープッシュ |

正式なリストは `src/gateway/server.ts`（`METHODS`、`EVENTS`）にあります。

## スキーマの場所

- ソース: `src/gateway/protocol/schema.ts`
- ランタイムバリデーター（AJV）: `src/gateway/protocol/index.ts`
- サーバーハンドシェイクとメソッドディスパッチ: `src/gateway/server.ts`
- ノードクライアント: `src/gateway/client.ts`
- 生成された JSON Schema: `dist/protocol.schema.json`
- 生成された Swift モデル: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## 現在のパイプライン

- `pnpm protocol:gen`
  - JSON Schema（draft-07）を `dist/protocol.schema.json` に書き出します。
- `pnpm protocol:gen:swift`
  - Swift の Gateway モデルを生成します。
- `pnpm protocol:check`
  - 両方のジェネレーターを実行し、出力がコミットされていることを確認します。

## ランタイムでのスキーマの使用方法

- **サーバーサイド**: すべての受信フレームは AJV で検証されます。ハンドシェイクは `ConnectParams` にマッチするパラメーターを持つ `connect` リクエストのみを受け付けます。
- **クライアントサイド**: JS クライアントは使用前にイベントとレスポンスフレームを検証します。
- **メソッドサーフェス**: Gateway は `hello-ok` でサポートされている `methods` と `events` をアドバタイズします。

## フレームの例

Connect（最初のメッセージ）:

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

Hello-ok レスポンス:

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

リクエストとレスポンス:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

イベント:

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## 最小クライアント（Node.js）

最小限の有用なフロー: connect + health。

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

## 実例: エンドツーエンドでメソッドを追加する

例: `{ ok: true, text }` を返す新しい `system.echo` リクエストを追加します。

1. **スキーマ（情報源）**

`src/gateway/protocol/schema.ts` に追加します:

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

両方を `ProtocolSchemas` に追加して型をエクスポートします:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **検証**

`src/gateway/protocol/index.ts` で AJV バリデーターをエクスポートします:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **サーバーの動作**

`src/gateway/server-methods/system.ts` にハンドラーを追加します:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

`src/gateway/server-methods.ts` に登録し（すでに `systemHandlers` をマージしている）、`src/gateway/server.ts` の `METHODS` に `"system.echo"` を追加します。

4. **再生成**

```bash
pnpm protocol:check
```

5. **テストとドキュメント**

`src/gateway/server.*.test.ts` にサーバーテストを追加し、ドキュメントにメソッドを記載します。

## Swift コード生成の動作

Swift ジェネレーターが生成するもの:

- `req`、`res`、`event`、`unknown` ケースを持つ `GatewayFrame` enum
- 強く型付けされたペイロード構造体/enum
- `ErrorCode` 値と `GATEWAY_PROTOCOL_VERSION`

不明なフレーム型は前方互換性のために生のペイロードとして保持されます。

## バージョニングと互換性

- `PROTOCOL_VERSION` は `src/gateway/protocol/schema.ts` にあります。
- クライアントは `minProtocol` + `maxProtocol` を送信します。サーバーは不一致を拒否します。
- Swift モデルは古いクライアントを壊さないよう不明なフレーム型を保持します。

## スキーマのパターンと慣例

- ほとんどのオブジェクトは厳格なペイロードのために `additionalProperties: false` を使用します。
- `NonEmptyString` は ID とメソッド/イベント名のデフォルトです。
- トップレベルの `GatewayFrame` は `type` の**ディスクリミネーター**を使用します。
- 副作用を持つメソッドは通常パラメーターに `idempotencyKey` を必要とします（例: `send`、`poll`、`agent`、`chat.send`）。

## ライブスキーマ JSON

生成された JSON Schema はリポジトリの `dist/protocol.schema.json` にあります。公開された生ファイルは通常以下で利用可能です。

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## スキーマを変更する際

1. TypeBox スキーマを更新します。
2. `pnpm protocol:check` を実行します。
3. 再生成されたスキーマと Swift モデルをコミットします。
