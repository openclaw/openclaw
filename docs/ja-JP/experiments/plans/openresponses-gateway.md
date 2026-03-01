---
summary: "計画: OpenResponses の /v1/responses エンドポイントを追加し、Chat Completions をクリーンに廃止する"
read_when:
  - /v1/responses Gateway サポートの設計または実装を行う場合
  - Chat Completions 互換性からの移行を計画する場合
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses Gateway 計画"
---

# OpenResponses Gateway 統合計画

## コンテキスト

OpenClaw Gateway は現在、`/v1/chat/completions` に最小限の OpenAI 互換 Chat Completions エンドポイントを公開しています（[OpenAI Chat Completions](/gateway/openai-http-api) を参照）。

Open Responses は OpenAI Responses API に基づいたオープンな推論標準です。エージェント型ワークフロー向けに設計されており、アイテムベースの入力とセマンティックなストリーミングイベントを使用します。OpenResponses 仕様は `/v1/chat/completions` ではなく `/v1/responses` を定義しています。

## 目標

- OpenResponses のセマンティクスに準拠した `/v1/responses` エンドポイントを追加します。
- Chat Completions を互換性レイヤーとして維持し、無効化および最終的な削除が容易な状態にします。
- 独立した再利用可能なスキーマで、バリデーションとパースを標準化します。

## 非目標

- 最初のパスでの完全な OpenResponses 機能パリティ（画像、ファイル、ホスト型ツール）。
- 内部エージェント実行ロジックやツールオーケストレーションの置き換え。
- 最初のフェーズ中の既存の `/v1/chat/completions` の動作変更。

## リサーチまとめ

出典: OpenResponses OpenAPI、OpenResponses 仕様サイト、Hugging Face ブログ投稿。

抽出された主要ポイント:

- `POST /v1/responses` は `model`、`input`（文字列または `ItemParam[]`）、`instructions`、`tools`、`tool_choice`、`stream`、`max_output_tokens`、`max_tool_calls` などの `CreateResponseBody` フィールドを受け付けます。
- `ItemParam` は以下の判別ユニオンです:
  - `system`、`developer`、`user`、`assistant` ロールを持つ `message` アイテム
  - `function_call` および `function_call_output`
  - `reasoning`
  - `item_reference`
- 成功したレスポンスは `object: "response"`、`status`、`output` アイテムを含む `ResponseResource` を返します。
- ストリーミングは以下のようなセマンティックイベントを使用します:
  - `response.created`、`response.in_progress`、`response.completed`、`response.failed`
  - `response.output_item.added`、`response.output_item.done`
  - `response.content_part.added`、`response.content_part.done`
  - `response.output_text.delta`、`response.output_text.done`
- 仕様の要件:
  - `Content-Type: text/event-stream`
  - `event:` は JSON の `type` フィールドと一致する必要があります
  - 終端イベントはリテラルの `[DONE]` でなければなりません
- Reasoning アイテムは `content`、`encrypted_content`、`summary` を公開する場合があります。
- HF の例にはリクエストに `OpenResponses-Version: latest` が含まれています（オプションヘッダー）。

## 提案するアーキテクチャ

- Zod スキーマのみを含む `src/gateway/open-responses.schema.ts` を追加します（Gateway インポートなし）。
- `/v1/responses` 用に `src/gateway/openresponses-http.ts`（または `open-responses-http.ts`）を追加します。
- `src/gateway/openai-http.ts` をレガシー互換アダプターとして維持します。
- コンフィグ `gateway.http.endpoints.responses.enabled`（デフォルト `false`）を追加します。
- `gateway.http.endpoints.chatCompletions.enabled` を独立して維持し、両エンドポイントを個別にトグルできるようにします。
- Chat Completions が有効な場合、レガシー状態を示すスタートアップ警告を出力します。

## Chat Completions の廃止パス

- 厳格なモジュール境界を維持: responses と chat completions 間でスキーマ型を共有しません。
- Chat Completions をコンフィグでオプトインとし、コード変更なしで無効化できるようにします。
- `/v1/responses` が安定したら、Chat Completions をレガシーとしてラベル付けするようにドキュメントを更新します。
- オプションの将来ステップ: Chat Completions リクエストを Responses ハンドラにマッピングし、シンプルな削除パスを提供します。

## フェーズ 1 サポートサブセット

- `input` を文字列または、メッセージロールと `function_call_output` を持つ `ItemParam[]` として受け付けます。
- system および developer メッセージを `extraSystemPrompt` に抽出します。
- エージェント実行の現在のメッセージとして、最新の `user` または `function_call_output` を使用します。
- サポートされていないコンテンツパーツ（画像/ファイル）を `invalid_request_error` で拒否します。
- `output_text` コンテンツを持つ単一のアシスタントメッセージを返します。
- トークン計算が接続されるまで、ゼロ値の `usage` を返します。

## バリデーション戦略（SDK なし）

- サポートされているサブセットの Zod スキーマを実装します:
  - `CreateResponseBody`
  - `ItemParam` + メッセージコンテンツパートユニオン
  - `ResponseResource`
  - Gateway が使用するストリーミングイベント形状
- ドリフトを避け、将来のコード生成を可能にするため、スキーマを単一の独立したモジュールに保持します。

## ストリーミング実装（フェーズ 1）

- `event:` と `data:` の両方を持つ SSE ライン。
- 必須シーケンス（最小限実行可能）:
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta`（必要に応じて繰り返し）
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## テストと検証計画

- `/v1/responses` の E2E カバレッジを追加します:
  - 認証必須
  - ノンストリームレスポンスの形状
  - ストリームイベントの順序と `[DONE]`
  - ヘッダーと `user` を使用したセッションルーティング
- `src/gateway/openai-http.test.ts` を変更しません。
- 手動: `stream: true` で `/v1/responses` に curl し、イベントの順序と終端 `[DONE]` を確認します。

## ドキュメント更新（フォローアップ）

- `/v1/responses` の使用例を記載した新しいドキュメントページを追加します。
- `/gateway/openai-http-api` にレガシーノートと `/v1/responses` へのポインタを追加して更新します。
