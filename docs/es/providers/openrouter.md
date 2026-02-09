---
summary: "Use la API unificada de OpenRouter para acceder a muchos modelos en OpenClaw"
read_when:
  - Quiere una sola clave de API para muchos LLM
  - Quiere ejecutar modelos a través de OpenRouter en OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter proporciona una **API unificada** que enruta solicitudes a muchos modelos detrás de un único
endpoint y una sola clave de API. Es compatible con OpenAI, por lo que la mayoría de los SDK de OpenAI funcionan al cambiar la URL base.

## Configuración de la CLI

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Fragmento de configuración

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

- Las referencias de modelos son `openrouter/<provider>/<model>`.
- Para más opciones de modelos/proveedores, consulte [/concepts/model-providers](/concepts/model-providers).
- OpenRouter utiliza un token Bearer con su clave de API internamente.
