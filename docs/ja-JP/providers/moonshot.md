---
read_when:
    - Moonshot K2（Moonshot Open Platform）と Kimi Coding のセットアップが必要な場合
    - 別々のエンドポイント、キー、モデル参照について理解したい場合
    - いずれかのプロバイダーのコピー＆ペースト用設定が必要な場合
summary: Moonshot K2 と Kimi Coding の設定（別々のプロバイダー + キー）
title: Moonshot AI
x-i18n:
    generated_at: "2026-04-02T08:58:26Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: f95e6ffa9397e0c2bdbc247e6fb6f2892ca6a34b276ca9b773e6b875233539e3
    source_path: providers/moonshot.md
    workflow: 15
---

# Moonshot AI (Kimi)

Moonshot は OpenAI 互換エンドポイントを持つ Kimi API を提供しています。プロバイダーを設定し、デフォルトモデルを `moonshot/kimi-k2.5` に設定するか、Kimi Coding で `kimi-coding/k2p5` を使用します。

現在の Kimi K2 モデル ID:

[//]: # "moonshot-kimi-k2-ids:start"

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`

[//]: # "moonshot-kimi-k2-ids:end"

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding:

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

注意: Moonshot と Kimi Coding は別々のプロバイダーです。キーは互換性がなく、エンドポイントが異なり、モデル参照も異なります（Moonshot は `moonshot/...`、Kimi Coding は `kimi-coding/...` を使用）。

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

- Moonshot のモデル参照は `moonshot/<modelId>` を使用します。Kimi Coding のモデル参照は `kimi-coding/<modelId>` を使用します。
- 必要に応じて `models.providers` で料金やコンテキストメタデータをオーバーライドできます。
- Moonshot がモデルごとに異なるコンテキスト制限を公開している場合は、`contextWindow` を適宜調整してください。
- 国際エンドポイントには `https://api.moonshot.ai/v1` を、中国エンドポイントには `https://api.moonshot.cn/v1` を使用してください。

## ネイティブ思考モード（Moonshot）

Moonshot Kimi はバイナリネイティブ思考をサポートしています:

- `thinking: { type: "enabled" }`
- `thinking: { type: "disabled" }`

`agents.defaults.models.<provider/model>.params` でモデルごとに設定します:

```json5
{
  agents: {
    defaults: {
      models: {
        "moonshot/kimi-k2.5": {
          params: {
            thinking: { type: "disabled" },
          },
        },
      },
    },
  },
}
```

OpenClaw は Moonshot のランタイム `/think` レベルも以下のようにマッピングします:

- `/think off` -> `thinking.type=disabled`
- off 以外の思考レベル -> `thinking.type=enabled`

Moonshot の思考が有効な場合、`tool_choice` は `auto` または `none` でなければなりません。OpenClaw は互換性のために、互換性のない `tool_choice` の値を `auto` に正規化します。
