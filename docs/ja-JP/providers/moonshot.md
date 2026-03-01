---
summary: "Moonshot K2 と Kimi Coding の設定（個別プロバイダーとキー）"
read_when:
  - Moonshot K2（Moonshot Open Platform）と Kimi Coding のセットアップが必要な場合
  - 個別のエンドポイント、キー、モデル参照を理解したい場合
  - どちらかのプロバイダーのコピー&ペースト用設定が欲しい場合
title: "Moonshot AI"
---

# Moonshot AI（Kimi）

MoonshotはOpenAI互換エンドポイントを持つKimi APIを提供しています。プロバイダーを設定してデフォルトモデルを `moonshot/kimi-k2.5` に設定するか、Kimi Codingを `kimi-coding/k2p5` で使用してください。

現在のKimi K2モデルID:

{/_moonshot-kimi-k2-ids:start_/ && null}

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-ids:end_/ && null}

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding:

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

注意: MoonshotとKimi Codingは別々のプロバイダーです。キーは互換性がなく、エンドポイントも異なり、モデル参照も異なります（Moonshotは `moonshot/...`、Kimi Codingは `kimi-coding/...` を使用します）。

## 設定スニペット（Moonshot API）

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: {
        // moonshot-kimi-k2-aliases:start
        "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
        "moonshot/kimi-k2-0905-preview": { alias: "Kimi K2" },
        "moonshot/kimi-k2-turbo-preview": { alias: "Kimi K2 Turbo" },
        "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
        "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },
        // moonshot-kimi-k2-aliases:end
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          // moonshot-kimi-k2-models:start
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-0905-preview",
            name: "Kimi K2 0905 Preview",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-turbo-preview",
            name: "Kimi K2 Turbo",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking",
            name: "Kimi K2 Thinking",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking-turbo",
            name: "Kimi K2 Thinking Turbo",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          // moonshot-kimi-k2-models:end
        ],
      },
    },
  },
}
```

## Kimi Coding

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: {
        "kimi-coding/k2p5": { alias: "Kimi K2.5" },
      },
    },
  },
}
```

## 注意事項

- Moonshotのモデル参照は `moonshot/<modelId>` を使用します。Kimi Codingのモデル参照は `kimi-coding/<modelId>` を使用します。
- 必要に応じて `models.providers` で料金とコンテキストメタデータをオーバーライドしてください。
- Moonshotがモデルの異なるコンテキスト制限を公開した場合は、`contextWindow` を適宜調整してください。
- 国際エンドポイントには `https://api.moonshot.ai/v1`、中国エンドポイントには `https://api.moonshot.cn/v1` を使用してください。
