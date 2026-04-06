---
read_when:
    - 自分のGPUマシンからモデルを提供したい場合
    - LM StudioやOpenAI互換プロキシを接続する場合
    - 最も安全なローカルモデルのガイダンスが必要な場合
summary: ローカルLLMでOpenClawを実行する（LM Studio、vLLM、LiteLLM、カスタムOpenAIエンドポイント）
title: ローカルモデル
x-i18n:
    generated_at: "2026-04-02T07:42:22Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 0d2dd5d0587327f98237c78c2f2b4e066eb6a470babfd0c3ea42e6d31871d320
    source_path: gateway/local-models.md
    workflow: 15
---

# ローカルモデル

ローカル実行は可能ですが、OpenClawは大きなコンテキスト＋プロンプトインジェクションに対する強力な防御を必要とします。小さなカードではコンテキストが切り詰められ、安全性が低下します。高いスペックを目指してください：**≥2台のフルスペックMac Studioまたは同等のGPUリグ（約$30k以上）**。単一の**24 GB** GPUは、軽いプロンプトでレイテンシーが高くなる場合にのみ動作します。実行可能な**最大/フルサイズのモデルバリアント**を使用してください。積極的に量子化された「小さい」チェックポイントはプロンプトインジェクションのリスクを高めます（[セキュリティ](/gateway/security)を参照）。

最も手軽なローカルセットアップが必要な場合は、[Ollama](/providers/ollama)と`openclaw onboard`から始めてください。このページは、ハイエンドなローカルスタックやカスタムOpenAI互換ローカルサーバー向けの実践的なガイドです。

## 推奨：LM Studio + 大規模ローカルモデル（Responses API）

現時点で最良のローカルスタックです。LM Studioに大規模モデル（例：フルサイズのQwen、DeepSeek、またはLlamaビルド）をロードし、ローカルサーバーを有効にして（デフォルト`http://127.0.0.1:1234`）、Responses APIを使用してリーズニングを最終テキストから分離します。

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/my-local-model" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/my-local-model": { alias: "Local" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

**セットアップチェックリスト**

- LM Studioをインストール：[https://lmstudio.ai](https://lmstudio.ai)
- LM Studioで**利用可能な最大のモデルビルド**をダウンロード（「小さい」/大幅に量子化されたバリアントは避ける）し、サーバーを起動して、`http://127.0.0.1:1234/v1/models`にリストされていることを確認します。
- `my-local-model`をLM Studioに表示される実際のモデルIDに置き換えてください。
- モデルをロードしたままにしてください。コールドロードは起動レイテンシーを増加させます。
- LM Studioのビルドが異なる場合は`contextWindow`/`maxTokens`を調整してください。
- WhatsAppの場合、最終テキストのみが送信されるようResponses APIを使用してください。

ローカル実行時もホストされたモデルの設定を保持してください。`models.mode: "merge"`を使用することでフォールバックが引き続き利用可能になります。

### ハイブリッド設定：ホストされたプライマリ、ローカルフォールバック

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["lmstudio/my-local-model", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
        "lmstudio/my-local-model": { alias: "Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### ローカル優先＋ホストされたセーフティネット

プライマリとフォールバックの順序を入れ替えます。同じプロバイダーブロックと`models.mode: "merge"`を保持することで、ローカルマシンがダウンした際にSonnetやOpusにフォールバックできます。

### リージョナルホスティング / データルーティング

- ホストされたMiniMax/Kimi/GLMバリアントはOpenRouterでリージョン固定エンドポイント（例：米国ホスト）としても利用可能です。そこでリージョンバリアントを選択することで、Anthropic/OpenAIフォールバックに`models.mode: "merge"`を使用しながら、選択した管轄内にトラフィックを維持できます。
- ローカルのみが最強のプライバシーパスです。ホストされたリージョナルルーティングは、プロバイダー機能が必要だがデータフローの制御が欲しい場合の中間的な選択肢です。

## その他のOpenAI互換ローカルプロキシ

vLLM、LiteLLM、OAI-proxy、またはカスタムゲートウェイは、OpenAIスタイルの`/v1`エンドポイントを公開していれば動作します。上記のプロバイダーブロックをお使いのエンドポイントとモデルIDに置き換えてください：

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

ホストされたモデルがフォールバックとして引き続き利用可能になるよう`models.mode: "merge"`を保持してください。

## トラブルシューティング

- Gateway ゲートウェイからプロキシに到達できますか？`curl http://127.0.0.1:1234/v1/models`で確認してください。
- LM Studioのモデルがアンロードされていますか？再ロードしてください。コールドスタートは「ハング」の一般的な原因です。
- コンテキストエラー？`contextWindow`を下げるか、サーバーの制限を引き上げてください。
- 安全性：ローカルモデルはプロバイダー側のフィルターをスキップします。エージェントを限定的に保ち、コンパクションを有効にしてプロンプトインジェクションの影響範囲を制限してください。
