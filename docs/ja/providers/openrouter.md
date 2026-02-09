---
summary: "OpenClaw で多数のモデルにアクセスするために OpenRouter の統合 API を使用します"
read_when:
  - 多数の LLM に対して単一の API キーを使いたい場合
  - OpenClaw で OpenRouter 経由のモデルを実行したい場合
title: "OpenRouter"
---

# OpenRouter

OpenRouter は、単一のエンドポイントと API キーの背後で多数のモデルへリクエストをルーティングする **統合 API** を提供します。OpenAI 互換であるため、ベース URL を切り替えるだけで、ほとんどの OpenAI SDK が動作します。 OpenAIと互換性があるため、ほとんどのOpenAISDKはベースURLを切り替えることで動作します。

## CLI setup

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Config snippet

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

## Notes

- モデル参照は `openrouter/<provider>/<model>` です。
- さらに多くのモデル／プロバイダーの選択肢については、[/concepts/model-providers](/concepts/model-providers) を参照してください。
- OpenRouter は内部的に、API キーを含む Bearer トークンを使用します。
