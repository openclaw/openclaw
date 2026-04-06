---
read_when:
    - 多数のLLMに単一のAPIキーでアクセスしたい場合
    - OpenClawでOpenRouter経由のモデルを実行したい場合
summary: OpenRouterの統合APIを使用して、OpenClawで多数のモデルにアクセスする
title: OpenRouter
x-i18n:
    generated_at: "2026-04-02T07:50:40Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: e7710634efec0549ccc4ce666342c0e4c3efc1ed0df978ddbb7fc763eabce47b
    source_path: providers/openrouter.md
    workflow: 15
---

# OpenRouter

OpenRouterは、単一のエンドポイントとAPIキーで多数のモデルにリクエストをルーティングする**統合API**を提供します。OpenAI互換のため、ほとんどのOpenAI SDKはベースURLを切り替えるだけで動作します。

## CLIセットアップ

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## 設定スニペット

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-6" },
    },
  },
}
```

## 注意事項

- モデル参照は`openrouter/<provider>/<model>`の形式です。
- その他のモデル/プロバイダーオプションについては、[/concepts/model-providers](/concepts/model-providers)を参照してください。
- OpenRouterは内部的にAPIキーを使用したBearerトークンを使用します。
