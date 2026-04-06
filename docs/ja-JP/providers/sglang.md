---
read_when:
    - ローカルのSGLangサーバーに対してOpenClawを実行したい場合
    - 自分のモデルでOpenAI互換の/v1エンドポイントを使用したい場合
summary: OpenClawをSGLang（OpenAI互換のセルフホストサーバー）で実行する
title: SGLang
x-i18n:
    generated_at: "2026-04-02T07:50:55Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 26ba858c46bc2b82088274c62270500ffc243e5fb505b8aaaffc096d835187b0
    source_path: providers/sglang.md
    workflow: 15
---

# SGLang

SGLangは**OpenAI互換**のHTTP APIを通じてオープンソースモデルを提供できます。
OpenClawは`openai-completions` APIを使用してSGLangに接続できます。

また、`SGLANG_API_KEY`を設定し（サーバーが認証を強制しない場合は任意の値で可）、明示的な`models.providers.sglang`エントリを定義していない場合、OpenClawはSGLangから利用可能なモデルを**自動検出**できます。

## クイックスタート

1. OpenAI互換サーバーとしてSGLangを起動します。

ベースURLは`/v1`エンドポイント（例: `/v1/models`、`/v1/chat/completions`）を公開する必要があります。SGLangは通常以下で動作します:

- `http://127.0.0.1:30000/v1`

2. オプトイン（認証が設定されていない場合は任意の値で可）:

```bash
export SGLANG_API_KEY="sglang-local"
```

3. オンボーディングを実行して`SGLang`を選択するか、モデルを直接設定します:

```bash
openclaw onboard
```

```json5
{
  agents: {
    defaults: {
      model: { primary: "sglang/your-model-id" },
    },
  },
}
```

## モデル検出（暗黙的プロバイダー）

`SGLANG_API_KEY`が設定されている（または認証プロファイルが存在する）状態で、`models.providers.sglang`を**定義していない**場合、OpenClawは以下にクエリを送信します:

- `GET http://127.0.0.1:30000/v1/models`

返されたIDはモデルエントリに変換されます。

`models.providers.sglang`を明示的に設定した場合、自動検出はスキップされ、モデルを手動で定義する必要があります。

## 明示的な設定（手動モデル）

以下の場合は明示的な設定を使用してください:

- SGLangが異なるホスト/ポートで動作している場合。
- `contextWindow`/`maxTokens`の値を固定したい場合。
- サーバーが実際のAPIキーを必要とする場合（またはヘッダーを制御したい場合）。

```json5
{
  models: {
    providers: {
      sglang: {
        baseUrl: "http://127.0.0.1:30000/v1",
        apiKey: "${SGLANG_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local SGLang Model",
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

- サーバーに到達可能か確認してください:

```bash
curl http://127.0.0.1:30000/v1/models
```

- 認証エラーでリクエストが失敗する場合は、サーバー設定と一致する実際の`SGLANG_API_KEY`を設定するか、`models.providers.sglang`でプロバイダーを明示的に設定してください。
