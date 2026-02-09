---
summary: "Gateway（ゲートウェイ）から OpenResponses 互換の /v1/responses HTTP エンドポイントを公開します"
read_when:
  - OpenResponses API を話すクライアントを統合する場合
  - アイテムベースの入力、クライアントツール呼び出し、または SSE イベントが必要な場合
title: "OpenResponses API"
---

# OpenResponses API（HTTP）

OpenClaw の Gateway は、OpenResponses 互換の `POST /v1/responses` エンドポイントを提供できます。

このエンドポイントは **デフォルトでは無効** です。まず設定で有効化してください。 最初に設定で有効にします。

- `POST /v1/responses`
- Gateway と同一ポート（WS + HTTP の多重化）: `http://<gateway-host>:<port>/v1/responses`

内部的には、リクエストは通常の Gateway エージェント実行として処理されます（
`openclaw agent` と同一のコードパス）。そのため、ルーティング／権限／設定は Gateway と一致します。

## 認証

ゲートウェイ認証設定を使用します。 ベアラートトークンを送信:

- `Authorization: Bearer <token>`

注記:

- `gateway.auth.mode="token"` の場合は、`gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）を使用します。
- `gateway.auth.mode="password"` の場合は、`gateway.auth.password`（または `OPENCLAW_GATEWAY_PASSWORD`）を使用します。

## エージェントの選択

カスタムヘッダーは不要です。OpenResponses の `model` フィールドにエージェント ID をエンコードします。

- `model: "openclaw:<agentId>"`（例: `"openclaw:main"`、`"openclaw:beta"`）
- `model: "agent:<agentId>"`（エイリアス）

または、ヘッダーで特定の OpenClaw エージェントを指定します。

- `x-openclaw-agent-id: <agentId>`（デフォルト: `main`）

高度な設定:

- セッションのルーティングを完全に制御するには `x-openclaw-session-key: <sessionKey>` を使用します。

## エンドポイントの有効化

`gateway.http.endpoints.responses.enabled` を `true` に設定します。

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## エンドポイントの無効化

`gateway.http.endpoints.responses.enabled` を `false` に設定します。

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## セッションの挙動

デフォルトでは、このエンドポイントは **リクエストごとにステートレス** です（呼び出しごとに新しいセッションキーが生成されます）。

リクエストに OpenResponses の `user` 文字列が含まれている場合、Gateway はそれから安定したセッションキーを導出します。これにより、繰り返しの呼び出しで同じエージェントセッションを共有できます。

## リクエスト形状（対応状況）

リクエストは、アイテムベース入力の OpenResponses API に従います。現在の対応状況は次のとおりです。 現在のサポート:

- `input`: 文字列、またはアイテムオブジェクトの配列。
- `instructions`: システムプロンプトにマージされます。
- `tools`: クライアントツール定義（関数ツール）。
- `tool_choice`: クライアントツールのフィルタまたは必須指定。
- `stream`: SSE ストリーミングを有効化します。
- `max_output_tokens`: ベストエフォートの出力上限（プロバイダー依存）。
- `user`: 安定したセッションルーティング。

受け付けますが **現在は無視** されます。

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## アイテム（入力）

### `message`

ロール: `system`、`developer`、`user`、`assistant`。

- `system` と `developer` はシステムプロンプトに追記されます。
- 最新の `user` または `function_call_output` アイテムが「現在のメッセージ」になります。
- それ以前の user/assistant メッセージは、文脈のための履歴として含まれます。

### `function_call_output`（ターンベースのツール）

ツールの結果をモデルに返送します。

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` と `item_reference`

スキーマ互換性のために受け付けますが、プロンプトの構築時には無視されます。

## ツール（クライアント側の関数ツール）

`tools: [{ type: "function", function: { name, description?, parameters? } }]` でツールを提供します。

エージェントがツール呼び出しを決定した場合、レスポンスには `function_call` の出力アイテムが返されます。
その後、`function_call_output` を含むフォローアップリクエストを送信してターンを継続します。
次に、`function_call_output` でフォローアップリクエストを送り、ターンを続けます。

## 画像（`input_image`）

base64 または URL ソースをサポートします。

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

許可される MIME タイプ（現時点）: `image/jpeg`、`image/png`、`image/gif`、`image/webp`。
最大サイズ（現時点）: 10MB。
最大サイズ（現在）：10MB。

## ファイル（`input_file`）

base64 または URL ソースをサポートします。

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

許可される MIME タイプ（現時点）: `text/plain`、`text/markdown`、`text/html`、`text/csv`、
`application/json`、`application/pdf`。

最大サイズ（現時点）: 5MB。

現在の挙動:

- ファイル内容はデコードされ、**ユーザーメッセージではなくシステムプロンプト** に追加されます。
  そのため、セッション履歴には永続化されず、一時的な扱いになります。
- PDF はテキストに対して解析されます。 PDF はテキスト解析されます。取得できるテキストが少ない場合は、最初のページを画像にラスタライズして
  モデルに渡します。

PDF の解析には、Node 向けの `pdfjs-dist` レガシービルド（ワーカーなし）を使用します。最新の
PDF.js ビルドはブラウザのワーカー／DOM グローバルを前提とするため、Gateway では使用されません。 現代の
PDF.js はブラウザーのワーカー/DOMグローバルを期待しているため、Gatewayでは使用されません。

URL フェッチのデフォルト:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- リクエストは保護されています（DNS 解決、プライベート IP のブロック、リダイレクト上限、タイムアウト）。

## ファイル＋画像の制限（設定）

デフォルト値は `gateway.http.endpoints.responses` 配下で調整できます。

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

省略時のデフォルト:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## ストリーミング（SSE）

`stream: true` を設定すると、Server-Sent Events（SSE）を受信します。

- `Content-Type: text/event-stream`
- 各イベント行は `event: <type>` と `data: <json>` です。
- ストリームは `data: [DONE]` で終了します。

現在送出されるイベントタイプ:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed`（エラー時）

## 使用量

基盤となるプロバイダーがトークン数を報告する場合、`usage` が設定されます。

## エラー

エラーは次のような JSON オブジェクトを使用します。

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

一般的なケース:

- 認証が欠落または無効: `401`
- リクエストボディが不正: `400`
- メソッドが不正: `405`

## 例

非ストリーミング:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

ストリーミング:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
