---
read_when:
    - ローカルのvLLMサーバーに対してOpenClawを実行したい場合
    - 自分のモデルでOpenAI互換の/v1エンドポイントを使用したい場合
summary: OpenClawをvLLM（OpenAI互換ローカルサーバー）で実行する
title: vLLM
x-i18n:
    generated_at: "2026-04-02T07:51:05Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 47a7b4a302fa829dd9de2da048d6ecd0cea843b84acf92455653a900976216c3
    source_path: providers/vllm.md
    workflow: 15
---

# vLLM

vLLMは、オープンソース（および一部のカスタム）モデルを**OpenAI互換**のHTTP APIで提供できます。OpenClawは `openai-completions` APIを使用してvLLMに接続できます。

また、`VLLM_API_KEY` を設定し（サーバーが認証を強制しない場合は任意の値で動作します）、明示的な `models.providers.vllm` エントリを定義しない場合、OpenClawはvLLMから利用可能なモデルを**自動検出**することもできます。

## クイックスタート

1. OpenAI互換サーバーとしてvLLMを起動します。

ベースURLは `/v1` エンドポイント（例: `/v1/models`、`/v1/chat/completions`）を公開する必要があります。vLLMは通常以下で実行されます:

- `http://127.0.0.1:8000/v1`

2. オプトインします（認証が設定されていない場合は任意の値で動作します）:

```bash
export VLLM_API_KEY="vllm-local"
```

3. モデルを選択します（vLLMのモデルIDに置き換えてください）:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vllm/your-model-id" },
    },
  },
}
```

## モデル検出（暗黙的プロバイダー）

`VLLM_API_KEY` が設定されている（または認証プロファイルが存在する）状態で、`models.providers.vllm` を**定義していない**場合、OpenClawは以下にクエリを送信します:

- `GET http://127.0.0.1:8000/v1/models`

…そして返されたIDをモデルエントリに変換します。

`models.providers.vllm` を明示的に設定した場合、自動検出はスキップされ、モデルを手動で定義する必要があります。

## 明示的な設定（手動モデル）

以下の場合は明示的な設定を使用します:

- vLLMが別のホスト/ポートで実行されている場合。
- `contextWindow`/`maxTokens` の値を固定したい場合。
- サーバーが実際のAPIキーを必要とする場合（またはヘッダーを制御したい場合）。

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local vLLM Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## トラブルシューティング

- サーバーに到達可能か確認します:

```bash
curl http://127.0.0.1:8000/v1/models
```

- 認証エラーでリクエストが失敗する場合は、サーバー設定に一致する実際の `VLLM_API_KEY` を設定するか、`models.providers.vllm` でプロバイダーを明示的に設定してください。
