---
summary: "Configuración de Perplexity Sonar para web_search"
read_when:
  - Deseas usar Perplexity Sonar para búsqueda web
  - Necesitas PERPLEXITY_API_KEY o configuración de OpenRouter
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw puede usar Perplexity Sonar para la herramienta `web_search`. Puedes conectar
a través de la API directa de Perplexity o mediante OpenRouter.

## Opciones de API

### Perplexity (directo)

- URL base: [https://api.perplexity.ai](https://api.perplexity.ai)
- Variable de entorno: `PERPLEXITY_API_KEY`

### OpenRouter (alternativa)

- URL base: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Variable de entorno: `OPENROUTER_API_KEY`
- Admite créditos prepagos/cripto.

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

## Cambiar desde Brave

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

Si tanto `PERPLEXITY_API_KEY` como `OPENROUTER_API_KEY` están establecidos, configura
`tools.web.search.perplexity.baseUrl` (o `tools.web.search.perplexity.apiKey`)
para desambiguar.

Si no se establece una URL base, OpenClaw elige un predeterminado basado en la fuente de la clave API:

- `PERPLEXITY_API_KEY` o `pplx-...` → Perplexity directo (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` o `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Formatos de clave desconocidos → OpenRouter (reserva segura)

## Modelos

- `perplexity/sonar` — P&R rápida con búsqueda web
- `perplexity/sonar-pro` (predeterminado) — razonamiento de múltiples pasos + búsqueda web
- `perplexity/sonar-reasoning-pro` — investigación profunda

Consulta [Herramientas web](/es-ES/tools/web) para ver la configuración completa de web_search.
