---
summary: "ローカル LLM（LM Studio、vLLM、LiteLLM、カスタム OpenAI エンドポイント）で OpenClaw を実行します"
read_when:
  - 自前の GPU マシンからモデルを提供したい場合
  - LM Studio や OpenAI 互換プロキシを接続している場合
  - 最も安全なローカルモデルのガイダンスが必要な場合
title: "ローカルモデル"
---

# ローカルモデル

ローカルは可能ですが、OpenClawは大きなコンテキストと迅速な注入に対する強力な防御を期待しています。 小さなカードはコンテキストを切り捨て、リークの安全性を確保します。 最高を目指して: **≥2 maxed-out Mac Studiosまたは同等のGPU リグ(〜$ 30k+)**。 単一の **24 GB** GPU は、より高いレイテンシを持つより軽いプロンプトに対してのみ動作します。 実行できる**最大/フルサイズのモデルバリアント**を使用してください。積極的にクオンタイズまたは「小さい」チェックポイントはプロンプトインジェクションのリスクを高めます ( [Security](/gateway/security)を参照してください)。

## 推奨：LM Studio + MiniMax M2.1（Responses API、フルサイズ）

現在の最高のローカルスタック。 現時点で最良のローカルスタックです。LM Studio に MiniMax M2.1 をロードし、ローカルサーバー（デフォルト `http://127.0.0.1:1234`）を有効化し、推論と最終テキストを分離するために Responses API を使用します。

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

- OpenRouter には、リージョン固定エンドポイント（例：US ホスト）を持つホスト型 MiniMax/Kimi/GLM バリアントも存在します。そこでリージョンバリアントを選択すれば、トラフィックを選択した法域内に留めつつ、Anthropic/OpenAI のフォールバックには `models.mode: "merge"` を引き続き使用できます。 \`models.mode: anthropic/OpenAI フォールバックの「merge」を使用しながら、選択した管轄区域内のトラフィックを保持するために、その地域のバリエーションを選んでください。
- ローカル専用は最も強力なプライバシー経路です。ホスト型のリージョンルーティングは、プロバイダー機能が必要だがデータフローの制御も行いたい場合の中間解です。

## その他の OpenAI 互換ローカルプロキシ

vLLM、LiteLLM、OAI-proxy、またはカスタム ゲートウェイ は、OpenAI 風の `/v1` エンドポイントを公開していれば動作します。上記の provider ブロックを、自身のエンドポイントとモデル ID に置き換えてください。 上のプロバイダブロックをエンドポイントとモデルIDに置き換えてください。

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

- Gateway（ゲートウェイ）からプロキシに到達できますか？ `curl http://127.0.0.1:1234/v1/models`。 `curl http://127.0.0.1:1234/v1/models`
- LM Studio のモデルがアンロードされていますか？ 再ロードしてください。コールドスタートは「ハング」する一般的な原因です。 リロード; コールドスタートは一般的な「絞首刑」の原因です。
- コンテキストエラーですか？ コンテキストエラーが出ますか？ `contextWindow` を下げるか、サーバー側の上限を引き上げてください。
- 安全性: ローカルモデルはプロバイダー側のフィルターをスキップします。迅速な射出ブラスト半径を制限するには、エージェントの絞り込みと圧縮を維持します。
