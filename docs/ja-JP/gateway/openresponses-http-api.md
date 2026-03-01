---
summary: "GatewayからOpenResponses互換の/v1/responses HTTPエンドポイントを公開"
read_when:
  - Integrating clients that speak the OpenResponses API
  - You want item-based inputs, client tool calls, or SSE events
title: "OpenResponses API"
---

# OpenResponses API（HTTP）

OpenClawのGatewayはOpenResponses互換の`POST /v1/responses`エンドポイントを提供できます。

このエンドポイントは**デフォルトで無効**です。最初に設定で有効にしてください。

- `POST /v1/responses`
- Gatewayと同じポート（WS + HTTP多重化）：`http://<gateway-host>:<port>/v1/responses`

内部的にはリクエストは通常のGatewayエージェント実行として処理されます（`openclaw agent`と同じコードパス）。ルーティング/権限/設定はGatewayと一致します。

## 認証

Gateway認証設定を使用します。Bearerトークンを送信してください：

- `Authorization: Bearer <token>`

注意：

- `gateway.auth.mode="token"`の場合、`gateway.auth.token`（または`OPENCLAW_GATEWAY_TOKEN`）を使用します。
- `gateway.auth.mode="password"`の場合、`gateway.auth.password`（または`OPENCLAW_GATEWAY_PASSWORD`）を使用します。
- `gateway.auth.rateLimit`が設定されていて認証失敗が多すぎる場合、エンドポイントは`Retry-After`付きの`429`を返します。

## エージェントの選択

カスタムヘッダーは不要です。OpenResponsesの`model`フィールドにエージェントIDをエンコードします：

- `model: "openclaw:<agentId>"`（例：`"openclaw:main"`、`"openclaw:beta"`）
- `model: "agent:<agentId>"`（エイリアス）

またはヘッダーで特定のOpenClawエージェントを指定します：

- `x-openclaw-agent-id: <agentId>`（デフォルト：`main`）

上級者向け：

- `x-openclaw-session-key: <sessionKey>` セッションルーティングを完全に制御します。

## エンドポイントの有効化

`gateway.http.endpoints.responses.enabled`を`true`に設定します：

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

`gateway.http.endpoints.responses.enabled`を`false`に設定します：

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

## セッション動作

デフォルトではエンドポイントは**リクエストごとにステートレス**です（各呼び出しで新しいセッションキーが生成されます）。

リクエストにOpenResponsesの`user`文字列が含まれている場合、Gatewayはそこから安定したセッションキーを導出するため、繰り返しの呼び出しでエージェントセッションを共有できます。

## リクエスト形式（サポート対象）

リクエストはアイテムベースの入力を持つOpenResponses APIに準拠します。現在のサポート：

- `input`：文字列またはアイテムオブジェクトの配列。
- `instructions`：システムプロンプトにマージされます。
- `tools`：クライアントツール定義（関数ツール）。
- `tool_choice`：クライアントツールのフィルターまたは要求。
- `stream`：SSEストリーミングを有効にします。
- `max_output_tokens`：ベストエフォートの出力制限（プロバイダー依存）。
- `user`：安定したセッションルーティング。

受け入れられますが**現在は無視**されます：

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## アイテム（input）

### `message`

ロール：`system`、`developer`、`user`、`assistant`。

- `system`と`developer`はシステムプロンプトに追加されます。
- 最新の`user`または`function_call_output`アイテムが「現在のメッセージ」になります。
- それ以前のuser/assistantメッセージはコンテキスト用の履歴として含まれます。

### `function_call_output`（ターンベースのツール）

ツールの結果をモデルに送り返します：

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning`と`item_reference`

スキーマ互換性のために受け入れられますが、プロンプト構築時には無視されます。

## ツール（クライアントサイドの関数ツール）

`tools: [{ type: "function", function: { name, description?, parameters? } }]`でツールを提供します。

エージェントがツールを呼び出すことを決定した場合、レスポンスは`function_call`出力アイテムを返します。
その後、`function_call_output`を含むフォローアップリクエストを送信してターンを継続します。

## 画像（`input_image`）

base64またはURLソースをサポートします：

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

許可されるMIMEタイプ（現在）：`image/jpeg`、`image/png`、`image/gif`、`image/webp`。
最大サイズ（現在）：10MB。

## ファイル（`input_file`）

base64またはURLソースをサポートします：

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

許可されるMIMEタイプ（現在）：`text/plain`、`text/markdown`、`text/html`、`text/csv`、
`application/json`、`application/pdf`。

最大サイズ（現在）：5MB。

現在の動作：

- ファイルコンテンツはデコードされて**システムプロンプト**に追加されます（ユーザーメッセージではありません）。そのためエフェメラル（セッション履歴に永続化されません）です。
- PDFはテキスト解析されます。テキストがほとんど見つからない場合、最初のページがラスタライズされて画像としてモデルに渡されます。

PDF解析はNode対応の`pdfjs-dist`レガシービルド（ワーカーなし）を使用します。モダンなPDF.jsビルドはブラウザワーカー/DOMグローバルを期待するため、Gatewayでは使用されません。

URLフェッチのデフォルト：

- `files.allowUrl`：`true`
- `images.allowUrl`：`true`
- `maxUrlParts`：`8`（リクエストごとのURLベースの`input_file` + `input_image`パーツの合計）
- リクエストはガードされています（DNS解決、プライベートIPブロッキング、リダイレクトキャップ、タイムアウト）。
- 入力タイプごとにオプションのホスト名許可リストがサポートされています（`files.urlAllowlist`、`images.urlAllowlist`）。
  - 正確なホスト：`"cdn.example.com"`
  - ワイルドカードサブドメイン：`"*.assets.example.com"`（apexにはマッチしません）

## ファイル + 画像の制限（設定）

デフォルトは`gateway.http.endpoints.responses`で調整できます：

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          maxUrlParts: 8,
          files: {
            allowUrl: true,
            urlAllowlist: ["cdn.example.com", "*.assets.example.com"],
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
            urlAllowlist: ["images.example.com"],
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

省略時のデフォルト：

- `maxBodyBytes`：20MB
- `maxUrlParts`：8
- `files.maxBytes`：5MB
- `files.maxChars`：200k
- `files.maxRedirects`：3
- `files.timeoutMs`：10秒
- `files.pdf.maxPages`：4
- `files.pdf.maxPixels`：4,000,000
- `files.pdf.minTextChars`：200
- `images.maxBytes`：10MB
- `images.maxRedirects`：3
- `images.timeoutMs`：10秒

セキュリティに関する注意：

- URL許可リストはフェッチ前とリダイレクトホップで適用されます。
- ホスト名を許可リストに追加しても、プライベート/内部IPブロッキングはバイパスされません。
- インターネットに公開されたGatewayの場合、アプリレベルのガードに加えてネットワークエグレスコントロールを適用してください。
  [セキュリティ](/gateway/security)を参照してください。

## ストリーミング（SSE）

`stream: true`を設定するとServer-Sent Events（SSE）を受信します：

- `Content-Type: text/event-stream`
- 各イベント行は`event: <type>`と`data: <json>`
- ストリームは`data: [DONE]`で終了

現在発行されるイベントタイプ：

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

`usage`は基盤となるプロバイダーがトークンカウントを報告する場合に設定されます。

## エラー

エラーは以下のようなJSONオブジェクトを使用します：

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

一般的なケース：

- `401` 認証の欠如/無効
- `400` 無効なリクエストボディ
- `405` 不正なメソッド

## 例

ノンストリーミング：

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

ストリーミング：

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
