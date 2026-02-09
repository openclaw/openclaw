---
summary: "OpenClaw içinde birçok modele erişmek için OpenRouter’ın birleşik API’sini kullanın"
read_when:
  - Birçok LLM için tek bir API anahtarı istiyorsunuz
  - OpenClaw’da OpenRouter üzerinden modeller çalıştırmak istiyorsunuz
title: "OpenRouter"
---

# OpenRouter

OpenRouter, istekleri tek bir uç nokta ve API anahtarı arkasında birçok modele yönlendiren **birleşik bir API** sunar. OpenAI ile uyumludur; bu nedenle çoğu OpenAI SDK’sı, yalnızca temel URL’yi değiştirerek çalışır.

## CLI kurulumu

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Yapılandırma parçacığı

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

## Notlar

- Model referansları `openrouter/<provider>/<model>` şeklindedir.
- Daha fazla model/sağlayıcı seçeneği için bkz. [/concepts/model-providers](/concepts/model-providers).
- OpenRouter, arka planda API anahtarınızla birlikte Bearer token kullanır.
