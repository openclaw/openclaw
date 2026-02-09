---
summary: "Gateway プロトコルの単一の信頼できる情報源としての TypeBox スキーマ"
read_when:
  - プロトコルスキーマやコード生成を更新する場合
title: "TypeBox"
---

# プロトコルの信頼できる情報源としての TypeBox

最終更新日: 2026-01-10

TypeBox は TypeScript ファーストのスキーマライブラリです。私たちはこれを使用して **Gateway WebSocket プロトコル**（ハンドシェイク、リクエスト/レスポンス、サーバーイベント）を定義しています。これらのスキーマは **ランタイム検証**、**JSON Schema のエクスポート**、および macOS アプリ向けの **Swift コード生成** を駆動します。単一の信頼できる情報源があり、その他はすべて生成されます。 **Gateway
WebSocket プロトコル** (ハンドシェイク、リクエスト、レスポンス、サーバーイベント) を定義します。 これらのスキーマ
はmacOSアプリの**ランタイム検証**、**JSONスキーマエクスポート**、**Swiftコード**を
ドライブします。 真実の一つの源;他のすべてが生成されます。

より高レベルのプロトコルの文脈を知りたい場合は、[Gateway アーキテクチャ](/concepts/architecture) から始めてください。

## メンタルモデル（30 秒）

すべての Gateway WS メッセージは、次の 3 種類のフレームのいずれかです。

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion? }`

最初のフレームは `connect` リクエストでなければなりません。 その後、クライアントは
メソッド(例: `health`, `send`, `chat.send`)を呼び出し、イベント(例:
`presence`, `tick`, `agent`)を購読することができます。

接続フロー（最小）:

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

一般的なメソッド + イベント:

| Category  | Examples                                                  | Notes                        |
| --------- | --------------------------------------------------------- | ---------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` が最初である必要があります      |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | 副作用には `idempotencyKey` が必要です |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat はこれらを使用します           |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | セッション管理                      |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + ノードアクション        |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | サーバープッシュ                     |

正式な一覧は `src/gateway/server.ts`（`METHODS`, `EVENTS`）にあります。

## スキーマの配置場所

- ソース: `src/gateway/protocol/schema.ts`
- ランタイムバリデーター（AJV）: `src/gateway/protocol/index.ts`
- サーバーのハンドシェイク + メソッドディスパッチ: `src/gateway/server.ts`
- ノードクライアント: `src/gateway/client.ts`
- 生成された JSON Schema: `dist/protocol.schema.json`
- 生成された Swift モデル: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## 現在のパイプライン

- `pnpm protocol:gen`
  - JSON Schema（draft‑07）を `dist/protocol.schema.json` に書き出します
- `pnpm protocol:gen:swift`
  - Swift の Gateway モデルを生成します
- `pnpm protocol:check`
  - 両方のジェネレーターを実行し、出力がコミットされていることを検証します

## ランタイムでのスキーマの使用方法

- **サーバー側**: すべての受信フレームは AJV で検証されます。ハンドシェイクは、params が `ConnectParams` に一致する `connect` リクエストのみを受け付けます。 ハンドシェイクのみ
  は、パラメータが `ConnectParams` にマッチする`connect` リクエストを受け付けます。
- **クライアント側**: JS クライアントは、イベントおよびレスポンスフレームを使用前に検証します。
- **メソッドサーフェス**: Gateway は、サポートされている `methods` と `events` を `hello-ok` で通知します。

## フレームの例

接続（最初のメッセージ）:

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

リクエスト + レスポンス:

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

最小で有用なフロー: 接続 + ヘルス。

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

例: 新しい `system.echo` リクエストを追加し、`{ ok: true, text }` を返します。

1. **スキーマ（信頼できる情報源）**

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

両方を `ProtocolSchemas` に追加し、型をエクスポートします:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **検証**

`src/gateway/protocol/index.ts` で、AJV バリデーターをエクスポートします:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **サーバーの振る舞い**

`src/gateway/server-methods/system.ts` にハンドラーを追加します:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

`src/gateway/server-methods.ts` に登録します（すでに `systemHandlers` をマージしています）。
その後、`src/gateway/server.ts` の `METHODS` に `"system.echo"` を追加します。

4. **再生成**

```bash
pnpm protocol:check
```

5. **テスト + ドキュメント**

`src/gateway/server.*.test.ts` にサーバーテストを追加し、ドキュメントにメソッドを記載します。

## Swift コード生成の挙動

Swift ジェネレーターは次を出力します:

- `req`, `res`, `event`, `unknown` のケースを持つ `GatewayFrame` enum
- 強く型付けされたペイロードの struct / enum
- `ErrorCode` の値と `GATEWAY_PROTOCOL_VERSION`

未知のフレームタイプは、前方互換性のために raw ペイロードとして保持されます。

## バージョニング + 互換性

- `PROTOCOL_VERSION` は `src/gateway/protocol/schema.ts` にあります。
- クライアントは `minProtocol` + `maxProtocol` を送信し、サーバーは不一致を拒否します。
- Swift モデルは、古いクライアントを破壊しないように未知のフレームタイプを保持します。

## スキーマのパターンと規約

- ほとんどのオブジェクトは、厳密なペイロードのために `additionalProperties: false` を使用します。
- ID やメソッド/イベント名のデフォルトは `NonEmptyString` です。
- トップレベルの `GatewayFrame` は、`type` に **discriminator** を使用します。
- 副作用を伴うメソッドは、通常 params に `idempotencyKey` を必要とします
  （例: `send`, `poll`, `agent`, `chat.send`）。

## ライブスキーマ JSON

生成された JSON Schema は、リポジトリ内の `dist/protocol.schema.json` にあります。
公開されている raw ファイルは、通常次の場所で利用できます:
公開された生ファイルは通常、以下で利用できます：

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## スキーマを変更する場合

1. TypeBox スキーマを更新します。
2. `pnpm protocol:check` を実行します。
3. 再生成されたスキーマと Swift モデルをコミットします。
