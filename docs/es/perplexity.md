---
summary: "Configuración de Perplexity Sonar para web_search"
read_when:
  - Quiere usar Perplexity Sonar para búsquedas web
  - Necesita PERPLEXITY_API_KEY o la configuración de OpenRouter
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw puede usar Perplexity Sonar para la herramienta `web_search`. Puede conectarse
a través de la API directa de Perplexity o mediante OpenRouter.

## Opciones de API

### Perplexity (directo)

- URL base: [https://api.perplexity.ai](https://api.perplexity.ai)
- Variable de entorno: `PERPLEXITY_API_KEY`

### OpenRouter (alternativa)

- URL base: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Variable de entorno: `OPENROUTER_API_KEY`
- Admite créditos prepagados/cripto.

## Ejemplo de configuración

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Cambio desde Brave

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
        },
      },
    },
  },
}
```

Si tanto `PERPLEXITY_API_KEY` como `OPENROUTER_API_KEY` están configurados, establezca
`tools.web.search.perplexity.baseUrl` (o `tools.web.search.perplexity.apiKey`)
para desambiguar.

Si no se establece ninguna URL base, OpenClaw elige un valor predeterminado según el origen de la clave de API:

- `PERPLEXITY_API_KEY` o `pplx-...` → Perplexity directo (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` o `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Formatos de clave desconocidos → OpenRouter (alternativa segura)

## Modelos

- `perplexity/sonar` — preguntas y respuestas rápidas con búsqueda web
- `perplexity/sonar-pro` (predeterminado) — razonamiento de varios pasos + búsqueda web
- `perplexity/sonar-reasoning-pro` — investigación profunda

Consulte [Herramientas web](/tools/web) para la configuración completa de web_search.
