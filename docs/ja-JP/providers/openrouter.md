---
summary: "OpenRouterの統合APIを使って多くのモデルをOpenClawで利用する"
read_when:
  - 多くのLLMに単一のAPIキーで利用したい場合
  - OpenClawでOpenRouter経由のモデルを実行したい場合
title: "OpenRouter"
---

# OpenRouter

OpenRouterは単一のエンドポイントとAPIキーで多くのモデルへのリクエストをルーティングする**統合API**を提供しています。OpenAI互換のため、ほとんどのOpenAI SDKはベースURLを切り替えるだけで動作します。

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

## 注意事項

- モデル参照は `openrouter/<provider>/<model>` の形式です。
- モデル/プロバイダーのオプションについては [/concepts/model-providers](/concepts/model-providers) を参照してください。
- OpenRouterは内部でAPIキーのBearerトークンを使用します。
