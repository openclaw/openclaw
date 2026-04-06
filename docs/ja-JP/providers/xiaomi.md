---
read_when:
    - Xiaomi MiMoモデルをOpenClawで使いたい場合
    - XIAOMI_API_KEYのセットアップが必要な場合
summary: Xiaomi MiMoモデルをOpenClawで使用する
title: Xiaomi MiMo
x-i18n:
    generated_at: "2026-04-02T07:51:08Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: e0abfbe49f438807ce1c5cf5d7910e930c0d670f447f6eb53ca4e9af61cc0843
    source_path: providers/xiaomi.md
    workflow: 15
---

# Xiaomi MiMo

Xiaomi MiMoは**MiMo**モデルのAPIプラットフォームです。OpenClawはXiaomiのOpenAI互換エンドポイントをAPIキー認証で使用します。[Xiaomi MiMoコンソール](https://platform.xiaomimimo.com/#/console/api-keys)でAPIキーを作成し、バンドルされた`xiaomi`プロバイダーにそのキーを設定してください。

## モデル概要

- **mimo-v2-flash**: デフォルトのテキストモデル、262144トークンのコンテキストウィンドウ
- **mimo-v2-pro**: 推論テキストモデル、1048576トークンのコンテキストウィンドウ
- **mimo-v2-omni**: テキストと画像入力に対応した推論マルチモーダルモデル、262144トークンのコンテキストウィンドウ
- ベースURL: `https://api.xiaomimimo.com/v1`
- API: `openai-completions`
- 認証: `Bearer $XIAOMI_API_KEY`

## CLIセットアップ

```bash
openclaw onboard --auth-choice xiaomi-api-key
# または非対話型
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
        baseUrl: "https://api.xiaomimimo.com/v1",
        api: "openai-completions",
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
          {
            id: "mimo-v2-pro",
            name: "Xiaomi MiMo V2 Pro",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1048576,
            maxTokens: 32000,
          },
          {
            id: "mimo-v2-omni",
            name: "Xiaomi MiMo V2 Omni",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

## 注意事項

- デフォルトのモデル参照: `xiaomi/mimo-v2-flash`
- 追加の組み込みモデル: `xiaomi/mimo-v2-pro`、`xiaomi/mimo-v2-omni`
- `XIAOMI_API_KEY`が設定されている場合（または認証プロファイルが存在する場合）、プロバイダーは自動的に注入されます。
- プロバイダーのルールについては[/concepts/model-providers](/concepts/model-providers)を参照してください。
