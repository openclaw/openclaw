---
summary: "OpenRouterの統合APIを使用してOpenClawで多数のモデルにアクセスする"
read_when:
  - 多数のLLMに単一のAPIキーでアクセスしたい場合
  - OpenClawでOpenRouter経由でモデルを実行したい場合
title: "OpenRouter"
x-i18n:
  source_path: "docs/providers/openrouter.md"
  generated_at: "2026-03-05T10:01:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
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
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## 備考

- モデル参照は `openrouter/<provider>/<model>` の形式です。
- その他のモデル/プロバイダーオプションについては、[/concepts/model-providers](/concepts/model-providers) を参照してください。
- OpenRouterは内部的にAPIキーを使用したBearerトークンを使用します。
