---
summary: "ローカルLLMでOpenClawを実行（LM Studio、vLLM、LiteLLM、カスタムOpenAIエンドポイント）"
read_when:
  - You want to serve models from your own GPU box
  - You are wiring LM Studio or an OpenAI-compatible proxy
  - You need the safest local model guidance
title: "ローカルモデル"
---

# ローカルモデル

ローカルは実行可能ですが、OpenClawは大きなコンテキストとプロンプトインジェクションに対する強力な防御を期待します。小さなカードはコンテキストを切り詰め、安全性を漏洩させます。高い目標を目指してください：**2台以上のフルスペックMac Studioまたは同等のGPUリグ（約30,000ドル以上）**。単一の**24 GB** GPUは、より軽いプロンプトで高レイテンシーの場合にのみ動作します。**実行可能な最大/フルサイズのモデルバリアント**を使用してください。積極的に量子化された「小さな」チェックポイントはプロンプトインジェクションのリスクを高めます（[セキュリティ](/gateway/security)を参照）。

## 推奨：LM Studio + MiniMax M2.1（Responses API、フルサイズ）

現時点で最良のローカルスタックです。LM StudioにMiniMax M2.1をロードし、ローカルサーバー（デフォルト`http://127.0.0.1:1234`）を有効にし、Responses APIを使用して推論を最終テキストから分離します。

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

- LM Studioをインストール：[https://lmstudio.ai](https://lmstudio.ai)
- LM Studioで**利用可能な最大のMiniMax M2.1ビルド**をダウンロードし（「小さい」/高度に量子化されたバリアントは避けてください）、サーバーを起動し、`http://127.0.0.1:1234/v1/models`にリストされていることを確認します。
- モデルをロードした状態に保ちます。コールドロードは起動レイテンシーを追加します。
- LM Studioのビルドが異なる場合は`contextWindow`/`maxTokens`を調整してください。
- WhatsAppの場合は、最終テキストのみが送信されるようにResponses APIを使用してください。

ローカル実行中でもホストされたモデルを設定したままにしておいてください。フォールバックが利用可能な状態を維持するために`models.mode: "merge"`を使用します。

### ハイブリッド設定：ホストされたプライマリ、ローカルフォールバック

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

### ローカルファーストとホストされたセーフティネット

プライマリとフォールバックの順序を入れ替えます。同じプロバイダーブロックと`models.mode: "merge"`を維持して、ローカルボックスがダウンしている場合にSonnetまたはOpusにフォールバックできるようにします。

### リージョナルホスティング / データルーティング

- ホストされたMiniMax/Kimi/GLMバリアントはOpenRouterでリージョン固定エンドポイント（例：米国ホスト）でも利用可能です。そこでリージョナルバリアントを選択して、Anthropic/OpenAIフォールバックに`models.mode: "merge"`を使用しながら、選択した管轄区域内にトラフィックを維持します。
- ローカルのみが最も強力なプライバシーパスです。プロバイダー機能が必要だがデータフローを制御したい場合は、ホストされたリージョナルルーティングが中間的な選択肢です。

## その他のOpenAI互換ローカルプロキシ

vLLM、LiteLLM、OAI-proxy、またはカスタムGatewayは、OpenAIスタイルの`/v1`エンドポイントを公開していれば動作します。上記のプロバイダーブロックをあなたのエンドポイントとモデルIDに置き換えてください：

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

ホストされたモデルがフォールバックとして利用可能な状態を維持するために`models.mode: "merge"`を使用してください。

## トラブルシューティング

- Gatewayがプロキシに到達できますか？`curl http://127.0.0.1:1234/v1/models`。
- LM Studioのモデルがアンロードされていますか？リロードしてください。コールドスタートは一般的な「ハング」の原因です。
- コンテキストエラー？`contextWindow`を下げるか、サーバーの制限を上げてください。
- 安全性：ローカルモデルはプロバイダー側のフィルターをスキップします。エージェントを狭く保ち、コンパクションを有効にしてプロンプトインジェクションの影響範囲を制限してください。
