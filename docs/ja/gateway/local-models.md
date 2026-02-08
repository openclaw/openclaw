---
summary: "ローカル LLM（LM Studio、vLLM、LiteLLM、カスタム OpenAI エンドポイント）で OpenClaw を実行します"
read_when:
  - 自前の GPU マシンからモデルを提供したい場合
  - LM Studio や OpenAI 互換プロキシを接続している場合
  - 最も安全なローカルモデルのガイダンスが必要な場合
title: "ローカルモデル"
x-i18n:
  source_path: gateway/local-models.md
  source_hash: 82164e8c4f0c7479
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:55Z
---

# ローカルモデル

ローカル運用は可能ですが、OpenClaw は **大きなコンテキスト** と **プロンプトインジェクションに対する強力な防御** を前提としています。小規模な GPU カードではコンテキストが切り詰められ、安全性が漏れやすくなります。目標は高めに設定してください：**最大構成の Mac Studio を 2 台以上、または同等の GPU リグ（約 $30k 以上）**。**24 GB** の単一 GPU でも軽いプロンプトであれば動作しますが、レイテンシは高くなります。**実行可能な中で最大／フルサイズのモデルバリアント** を使用してください。過度に量子化された、または「小型」のチェックポイントは、プロンプトインジェクションのリスクを高めます（[Security](/gateway/security) を参照）。

## 推奨：LM Studio + MiniMax M2.1（Responses API、フルサイズ）

現時点で最良のローカルスタックです。LM Studio に MiniMax M2.1 をロードし、ローカルサーバー（デフォルト `http://127.0.0.1:1234`）を有効化し、推論と最終テキストを分離するために Responses API を使用します。

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
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
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
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

- LM Studio をインストールします： [https://lmstudio.ai](https://lmstudio.ai)
- LM Studio で **利用可能な最大の MiniMax M2.1 ビルド** をダウンロードします（「small」や強く量子化されたバリアントは避けてください）。サーバーを起動し、`http://127.0.0.1:1234/v1/models` に一覧表示されることを確認します。
- モデルは常にロードしたままにしてください。コールドロードは起動レイテンシを追加します。
- LM Studio のビルドが異なる場合は、`contextWindow`/`maxTokens` を調整します。
- WhatsApp では、最終テキストのみが送信されるよう Responses API を使用してください。

ローカル実行時でもホスト型モデルは設定したままにしてください。フォールバックを利用可能にするため、`models.mode: "merge"` を使用します。

### ハイブリッド構成：ホスト型をプライマリ、ローカルをフォールバック

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
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
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
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

### ローカル優先＋ホスト型のセーフティネット

プライマリとフォールバックの順序を入れ替えます。同じ providers ブロックと `models.mode: "merge"` を維持し、ローカル環境が停止した場合でも Sonnet や Opus にフォールバックできるようにします。

### リージョン別ホスティング／データルーティング

- OpenRouter には、リージョン固定エンドポイント（例：US ホスト）を持つホスト型 MiniMax/Kimi/GLM バリアントも存在します。そこでリージョンバリアントを選択すれば、トラフィックを選択した法域内に留めつつ、Anthropic/OpenAI のフォールバックには `models.mode: "merge"` を引き続き使用できます。
- ローカル専用は最も強力なプライバシー経路です。ホスト型のリージョンルーティングは、プロバイダー機能が必要だがデータフローの制御も行いたい場合の中間解です。

## その他の OpenAI 互換ローカルプロキシ

vLLM、LiteLLM、OAI-proxy、またはカスタム ゲートウェイ は、OpenAI 風の `/v1` エンドポイントを公開していれば動作します。上記の provider ブロックを、自身のエンドポイントとモデル ID に置き換えてください。

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

ホスト型モデルをフォールバックとして利用可能にするため、`models.mode: "merge"` は維持してください。

## トラブルシューティング

- Gateway（ゲートウェイ）からプロキシに到達できますか？ `curl http://127.0.0.1:1234/v1/models`。
- LM Studio のモデルがアンロードされていますか？ 再ロードしてください。コールドスタートは「ハング」する一般的な原因です。
- コンテキストエラーが出ますか？ `contextWindow` を下げるか、サーバー側の上限を引き上げてください。
- 安全性：ローカルモデルはプロバイダー側のフィルターを通過しません。エージェントは用途を絞り、コンパクションを有効にして、プロンプトインジェクションの影響範囲を制限してください。
