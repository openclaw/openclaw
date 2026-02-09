---
summary: "OpenClaw で Xiaomi MiMo（mimo-v2-flash）を使用します"
read_when:
  - OpenClaw で Xiaomi MiMo モデルを使用したい場合
  - XIAOMI_API_KEY のセットアップが必要な場合
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMoは**MiMo**モデルのAPIプラットフォームです。
OpenAIおよびAnthropic形式と互換性のあるREST APIを提供し、認証にAPIキーを使用します。 Xiaomi MiMo は **MiMo** モデル向けの API プラットフォームです。OpenAI および Anthropic 形式と互換性のある REST API を提供し、認証には API キーを使用します。API キーは [Xiaomi MiMo コンソール](https://platform.xiaomimimo.com/#/console/api-keys) で作成してください。OpenClaw は Xiaomi MiMo の API キーを使用して `xiaomi` プロバイダーを利用します。 OpenClawはXiaomi MiMo APIキーを持つ`xiaomi`プロバイダ
を使用します。

## モデル概要

- **mimo-v2-flash**: 262144 トークンのコンテキストウィンドウ、Anthropic Messages API と互換。
- ベース URL: `https://api.xiaomimimo.com/anthropic`
- 認証: `Bearer $XIAOMI_API_KEY`

## CLI セットアップ

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## 設定スニペット

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## 注記

- モデル参照: `xiaomi/mimo-v2-flash`。
- `XIAOMI_API_KEY` が設定されている場合（または認証プロファイルが存在する場合）、プロバイダーは自動的に注入されます。
- プロバイダーのルールについては [/concepts/model-providers](/concepts/model-providers) を参照してください。
