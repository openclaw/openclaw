---
summary: "Usa la API unificada de OpenRouter para acceder a muchos modelos en OpenClaw"
read_when:
  - Quieres una única clave de API para muchos LLMs
  - Quieres ejecutar modelos mediante OpenRouter en OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter proporciona una **API unificada** que enruta solicitudes a muchos modelos detrás de un único
endpoint y clave de API. Es compatible con OpenAI, por lo que la mayoría de los SDKs de OpenAI funcionan al cambiar la URL base.

## Configuración mediante CLI

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

- Las referencias de modelo son `openrouter/<provider>/<model>`.
- Para más opciones de modelo/proveedor, ver [/es-ES/concepts/model-providers](/es-ES/concepts/model-providers).
- OpenRouter usa un token Bearer con tu clave de API bajo el capó.
