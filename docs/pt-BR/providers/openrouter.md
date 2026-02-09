---
summary: "Use a API unificada da OpenRouter para acessar muitos modelos no OpenClaw"
read_when:
  - Você quer uma única chave de API para muitos LLMs
  - Você quer executar modelos via OpenRouter no OpenClaw
title: "OpenRouter"
---

# OpenRouter

A OpenRouter fornece uma **API unificada** que roteia solicitações para muitos modelos por trás de um único
endpoint e chave de API. Ela é compatível com a OpenAI, então a maioria dos SDKs da OpenAI funciona ao trocar a URL base.

## Configuração da CLI

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Trecho de configuração

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

## Notas

- As referências de modelo são `openrouter/<provider>/<model>`.
- Para mais opções de modelos/provedores, veja [/concepts/model-providers](/concepts/model-providers).
- A OpenRouter usa um token Bearer com sua chave de API nos bastidores.
