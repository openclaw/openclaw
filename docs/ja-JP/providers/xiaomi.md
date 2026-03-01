---
summary: "Xiaomi MiMo（mimo-v2-flash）をOpenClawで使用する"
read_when:
  - OpenClawでXiaomi MiMoモデルを使いたい場合
  - XIAOMI_API_KEYのセットアップが必要な場合
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMoは**MiMo**モデルのAPIプラットフォームです。OpenAIおよびAnthropicフォーマット互換のREST APIを提供し、APIキーで認証します。[Xiaomi MiMoコンソール](https://platform.xiaomimimo.com/#/console/api-keys) でAPIキーを作成してください。OpenClawはXiaomi MiMo APIキーで `xiaomi` プロバイダーを使用します。

## モデル概要

- **mimo-v2-flash**: 262144トークンのコンテキストウィンドウ、Anthropic Messages API互換。
- ベースURL: `https://api.xiaomimimo.com/anthropic`
- 認証: `Bearer $XIAOMI_API_KEY`

## CLIセットアップ

```bash
openclaw onboard --auth-choice xiaomi-api-key
# または非インタラクティブ
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

## 注意事項

- モデル参照: `xiaomi/mimo-v2-flash`。
- `XIAOMI_API_KEY` が設定されている場合（または認証プロファイルが存在する場合）、プロバイダーは自動的に注入されます。
- プロバイダールールについては [/concepts/model-providers](/concepts/model-providers) を参照してください。
