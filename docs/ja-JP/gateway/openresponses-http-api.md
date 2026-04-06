---
read_when:
    - OpenResponses APIを使用するクライアントを統合する場合
    - アイテムベースの入力、クライアントツール呼び出し、またはSSEイベントが必要な場合
summary: Gateway ゲートウェイからOpenResponses互換の /v1/responses HTTPエンドポイントを公開する
title: OpenResponses API
x-i18n:
    generated_at: "2026-04-02T08:31:36Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 24dadcb92e9a71d2a022bfd8aae08cd1718053e0d763f609aecc5667d0c9bf50
    source_path: gateway/openresponses-http-api.md
    workflow: 15
---

# OpenResponses API (HTTP)

OpenClawの Gateway ゲートウェイは、OpenResponses互換の `POST /v1/responses` エンドポイントを提供できます。

このエンドポイントは**デフォルトで無効**です。まず設定で有効にしてください。

- `POST /v1/responses`
- Gateway ゲートウェイと同じポート（WS + HTTPマルチプレックス）：`http://<gateway-host>:<port>/v1/responses`

内部的には、リクエストは通常の Gateway ゲートウェイのエージェント実行（`openclaw agent` と同じコードパス）として処理されるため、ルーティング/権限/設定は Gateway ゲートウェイの設定と一致します。

## 認証、セキュリティ、ルーティング

動作は [OpenAI Chat Completions](/gateway/openai-http-api) と同じです：

- 通常の Gateway ゲートウェイ認証設定で `Authorization: Bearer <token>` を使用
- エンドポイントを Gateway ゲートウェイインスタンスの完全なオペレーターアクセスとして扱う
- 共有シークレット認証モード（`token` および `password`）では、bearerで宣言されたより狭い `x-openclaw-scopes` 値を無視し、通常の完全なオペレーターデフォルトを復元する
- 信頼されたID付きHTTPモード（例：信頼されたプロキシ認証や `gateway.auth.mode="none"`）では、リクエストで宣言されたオペレータースコープを引き続き尊重する
- `model: "openclaw"`、`model: "openclaw/default"`、`model: "openclaw/<agentId>"`、または `x-openclaw-agent-id` でエージェントを選択
- 選択されたエージェントのバックエンドモデルをオーバーライドしたい場合は `x-openclaw-model` を使用
- 明示的なセッションルーティングには `x-openclaw-session-key` を使用
- デフォルト以外の合成イングレスチャネルコンテキストが必要な場合は `x-openclaw-message-channel` を使用

認証マトリクス：

- `gateway.auth.mode="token"` または `"password"` + `Authorization: Bearer ...`
  - Gateway ゲートウェイのオペレーター共有シークレットの所有を証明する
  - より狭い `x-openclaw-scopes` を無視する
  - 完全なデフォルトオペレータースコープセットを復元する
  - このエンドポイントでのチャットターンをオーナー送信者ターンとして扱う
- 信頼されたID付きHTTPモード（例：信頼されたプロキシ認証、またはプライベートイングレスでの `gateway.auth.mode="none"`）
  - 宣言された `x-openclaw-scopes` ヘッダーを尊重する
  - 宣言されたスコープに `operator.admin` が実際に含まれている場合のみオーナーセマンティクスを取得する

このエンドポイントの有効/無効は `gateway.http.endpoints.responses.enabled` で設定します。

同じ互換性サーフェスには以下も含まれます：

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/embeddings`
- `POST /v1/chat/completions`

エージェントターゲットモデル、`openclaw/default`、エンベディングパススルー、バックエンドモデルオーバーライドの仕組みについての正式な説明は、[OpenAI Chat Completions](/gateway/openai-http-api#agent-first-model-contract) と [モデルリストとエージェントルーティング](/gateway/openai-http-api#model-list-and-agent-routing) を参照してください。

## セッション動作

デフォルトでは、エンドポイントは**リクエストごとにステートレス**です（各呼び出しで新しいセッションキーが生成されます）。

リクエストにOpenResponsesの `user` 文字列が含まれている場合、Gateway ゲートウェイはそこから安定したセッションキーを導出し、繰り返しの呼び出しでエージェントセッションを共有できるようになります。

## リクエスト形式（サポート対象）

リクエストはアイテムベースの入力を使用するOpenResponses APIに従います。現在のサポート：

- `input`：文字列またはアイテムオブジェクトの配列。
- `instructions`：システムプロンプトにマージされます。
- `tools`：クライアントツール定義（functionツール）。
- `tool_choice`：クライアントツールのフィルタまたは必須指定。
- `stream`：SSEストリーミングを有効にします。
- `max_output_tokens`：ベストエフォートの出力制限（プロバイダー依存）。
- `user`：安定したセッションルーティング。

受け入れるが**現在は無視**されるもの：

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `truncation`

サポート対象：

- `previous_response_id`：リクエストが同じエージェント/ユーザー/リクエストセッションスコープ内にある場合、OpenClawは以前のレスポンスセッションを再利用します。

## アイテム（input）

### `message`

ロール：`system`、`developer`、`user`、`assistant`。

- `system` と `developer` はシステムプロンプトに追加されます。
- 最新の `user` または `function_call_output` アイテムが「現在のメッセージ」になります。
- 以前のuser/assistantメッセージはコンテキストの履歴として含まれます。

### `function_call_output`（ターンベースツール）

ツールの結果をモデルに返します：

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` と `item_reference`

スキーマ互換性のために受け入れますが、プロンプト構築時には無視されます。

## ツール（クライアントサイドfunctionツール）

`tools: [{ type: "function", function: { name, description?, parameters? } }]` でツールを提供します。

エージェントがツールの呼び出しを決定した場合、レスポンスは `function_call` 出力アイテムを返します。
その後、`function_call_output` を含むフォローアップリクエストを送信してターンを続行します。

## 画像（`input_image`）

base64またはURLソースをサポート：

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

許可されるMIMEタイプ（現時点）：`image/jpeg`、`image/png`、`image/gif`、`image/webp`、`image/heic`、`image/heif`。
最大サイズ（現時点）：10MB。

## ファイル（`input_file`）

base64またはURLソースをサポート：

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

許可されるMIMEタイプ（現時点）：`text/plain`、`text/markdown`、`text/html`、`text/csv`、
`application/json`、`application/pdf`。

最大サイズ（現時点）：5MB。

現在の動作：

- ファイルコンテンツはデコードされ、ユーザーメッセージではなく**システムプロンプト**に追加されるため、
  一時的なものとなります（セッション履歴には永続化されません）。
- PDFはテキスト抽出のために解析されます。テキストがほとんど見つからない場合、最初の数ページが
  画像にラスタライズされてモデルに渡されます。

PDF解析にはNode対応の `pdfjs-dist` レガシービルド（ワーカーなし）を使用します。最新の
PDF.jsビルドはブラウザのworkers/DOMグローバルを想定しているため、Gateway ゲートウェイでは使用されません。

URLフェッチのデフォルト：

- `files.allowUrl`：`true`
- `images.allowUrl`：`true`
- `maxUrlParts`：`8`（リクエストあたりのURLベース `input_file` + `input_image` パーツの合計）
- リクエストはガード付きです（DNS解決、プライベートIPブロック、リダイレクト制限、タイムアウト）。
- 入力タイプごとにオプションのホスト名許可リストがサポートされています（`files.urlAllowlist`、`images.urlAllowlist`）。
  - 完全一致ホスト：`"cdn.example.com"`
  - ワイルドカードサブドメイン：`"*.assets.example.com"`（apexには一致しません）
  - 空または省略された許可リストは、ホスト名許可リストの制限なしを意味します。
- URLベースのフェッチを完全に無効にするには、`files.allowUrl: false` および/または `images.allowUrl: false` を設定してください。

## ファイル + 画像の制限（設定）

デフォルトは `gateway.http.endpoints.responses` で調整できます：

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
            allowedMimes: [
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "image/heic",
              "image/heif",
            ],
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
- HEIC/HEIF `input_image` ソースは受け入れられ、プロバイダーへの配信前にJPEGに正規化されます。

セキュリティに関する注意：

- URL許可リストはフェッチ前およびリダイレクトホップ時に適用されます。
- ホスト名を許可リストに追加しても、プライベート/内部IPブロックはバイパスされません。
- インターネットに公開された Gateway ゲートウェイでは、アプリケーションレベルのガードに加えてネットワークエグレス制御を適用してください。
  [セキュリティ](/gateway/security) を参照してください。

## ストリーミング（SSE）

`stream: true` を設定するとServer-Sent Events（SSE）を受信できます：

- `Content-Type: text/event-stream`
- 各イベント行は `event: <type>` と `data: <json>`
- ストリームは `data: [DONE]` で終了

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

`usage` は、基盤となるプロバイダーがトークン数を報告した場合に入力されます。

## エラー

エラーは以下のようなJSONオブジェクトを使用します：

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

一般的なケース：

- `401` 認証の欠落/無効
- `400` 無効なリクエストボディ
- `405` 不正なメソッド

## 使用例

非ストリーミング：

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
