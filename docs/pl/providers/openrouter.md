---
summary: "Użyj zunifikowanego API OpenRouter, aby uzyskać dostęp do wielu modeli w OpenClaw"
read_when:
  - Chcesz jednego klucza API dla wielu LLM-ów
  - Chcesz uruchamiać modele przez OpenRouter w OpenClaw
title: "OpenRouter"
x-i18n:
  source_path: providers/openrouter.md
  source_hash: b7e29fc9c456c64d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:27Z
---

# OpenRouter

OpenRouter udostępnia **zunifikowane API**, które kieruje żądania do wielu modeli za jednym
punktem końcowym i jednym kluczem API. Jest kompatybilne z OpenAI, więc większość SDK OpenAI działa po zmianie bazowego adresu URL.

## Konfiguracja CLI

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Fragment konfiguracji

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

## Uwagi

- Odwołania do modeli to `openrouter/<provider>/<model>`.
- Aby poznać więcej opcji modeli/dostawców, zobacz [/concepts/model-providers](/concepts/model-providers).
- OpenRouter korzysta wewnętrznie z tokenu Bearer zawierającego Twój klucz API.
