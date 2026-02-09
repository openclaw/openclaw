---
summary: "計画: OpenResponses /v1/responses エンドポイントを追加し、Chat Completions をクリーンに非推奨化する"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses Gateway 計画"
---

# OpenResponses Gateway 統合計画

## Context

OpenClaw Gateway は現在、OpenAI 互換の最小限な Chat Completions エンドポイントを
`/v1/chat/completions` で公開しています（[OpenAI Chat Completions](/gateway/openai-http-api) を参照）。

Open Responses は OpenAI Responses API に基づくオープンな推論標準です。エージェント指向のワークフロー向けに設計されており、アイテムベースの入力とセマンティックなストリーミングイベントを使用します。OpenResponses の仕様では `/v1/responses` を定義しており、`/v1/chat/completions` ではありません。
は、agenticワークフロー用に設計されており、アイテムベースの入力とセマンティックストリーミングイベントを使用しています。 OpenResponses
仕様では、 `/v1/chat/completions` ではなく、 `/v1/responses` が定義されています。

## Goals

- OpenResponses のセマンティクスに準拠する `/v1/responses` エンドポイントを追加します。
- Chat Completions を、無効化が容易で将来的に削除可能な互換レイヤーとして維持します。
- 分離され再利用可能なスキーマにより、検証とパースを標準化します。

## Non-goals

- 初回では OpenResponses の完全な機能パリティ（画像、ファイル、ホスト型ツール）は対象外です。
- 内部のエージェント実行ロジックやツールオーケストレーションの置き換えは行いません。
- 第 1 フェーズでは既存の `/v1/chat/completions` の挙動を変更しません。

## Research Summary

出典: OpenResponses OpenAPI、OpenResponses 仕様サイト、Hugging Face のブログ記事。

抽出した主なポイント:

- `POST /v1/responses` は、`model`、`input`（文字列または `ItemParam[]`）、`instructions`、`tools`、`tool_choice`、`stream`、`max_output_tokens`、`max_tool_calls` といった `CreateResponseBody` フィールドを受け付けます。
- `ItemParam` は次の判別共用体です:
  - ロールが `system`、`developer`、`user`、`assistant` の `message` アイテム
  - `function_call` と `function_call_output`
  - `reasoning`
  - `item_reference`
- 成功レスポンスは、`object: "response"`、`status`、`output` のアイテムを含む `ResponseResource` を返します。
- ストリーミングは次のようなセマンティックイベントを使用します:
  - `response.created`、`response.in_progress`、`response.completed`、`response.failed`
  - `response.output_item.added`、`response.output_item.done`
  - `response.content_part.added`、`response.content_part.done`
  - `response.output_text.delta`、`response.output_text.done`
- 仕様の要件:
  - `Content-Type: text/event-stream`
  - `event:` は JSON の `type` フィールドと一致する必要があります。
  - 終端イベントはリテラルの `[DONE]` でなければなりません。
- 推論アイテムは `content`、`encrypted_content`、`summary` を公開する場合があります。
- HF の例では、リクエストに `OpenResponses-Version: latest`（任意ヘッダー）が含まれます。

## Proposed Architecture

- Zod スキーマのみを含む `src/gateway/open-responses.schema.ts` を追加します（Gateway の import は行いません）。
- `/v1/responses` 用に `src/gateway/openresponses-http.ts`（または `open-responses-http.ts`）を追加します。
- レガシー互換アダプターとして `src/gateway/openai-http.ts` を維持します。
- 設定 `gateway.http.endpoints.responses.enabled` を追加します（デフォルトは `false`）。
- `gateway.http.endpoints.chatCompletions.enabled` は独立性を保ち、両エンドポイントを個別にトグル可能にします。
- Chat Completions が有効な場合、レガシー状態を示す起動時警告を出力します。

## Deprecation Path for Chat Completions

- 厳密なモジュール境界を維持します。responses と chat completions 間でスキーマ型を共有しません。
- 設定により Chat Completions をオプトインにし、コード変更なしで無効化できるようにします。
- `/v1/responses` が安定したら、ドキュメントで Chat Completions をレガシーとして明示します。
- 将来的な任意ステップ: 削除を容易にするため、Chat Completions のリクエストを Responses ハンドラーへマッピングします。

## Phase 1 Support Subset

- `input` を文字列、またはメッセージロールと `function_call_output` を持つ `ItemParam[]` として受け付けます。
- system および developer メッセージを `extraSystemPrompt` に抽出します。
- エージェント実行の現在メッセージとして、最新の `user` または `function_call_output` を使用します。
- 未対応のコンテンツパーツ（画像／ファイル）は `invalid_request_error` で拒否します。
- `output_text` コンテンツを含む単一の assistant メッセージを返します。
- トークン計測が接続されるまで、ゼロ化した値の `usage` を返します。

## Validation Strategy (No SDK)

- 次のサポート対象サブセットに対する Zod スキーマを実装します:
  - `CreateResponseBody`
  - `ItemParam` + メッセージコンテンツパーツの共用体
  - `ResponseResource`
  - Gateway で使用されるストリーミングイベントの形状
- ドリフトを防ぎ、将来のコード生成を可能にするため、スキーマは単一の分離モジュールに保持します。

## Streaming Implementation (Phase 1)

- `event:` と `data:` の両方を含む SSE 行。
- 必須シーケンス（最小実装）:
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta`（必要に応じて繰り返し）
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Tests and Verification Plan

- `/v1/responses` に対する e2e カバレッジを追加します:
  - 認証が必須であること
  - 非ストリームレスポンスの形状
  - ストリームイベントの順序と `[DONE]`
  - ヘッダーおよび `user` を用いたセッションルーティング
- `src/gateway/openai-http.e2e.test.ts` は変更しません。
- 手動: `stream: true` を付けて `/v1/responses` に curl し、イベント順序と終端の `[DONE]` を確認します。

## Doc Updates (Follow-up)

- `/v1/responses` の使用方法と例のための新しいドキュメントページを追加します。
- `/gateway/openai-http-api` を更新し、レガシー注記と `/v1/responses` へのポインターを追加します。
