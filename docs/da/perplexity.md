---
summary: "Opsætning af Perplexity Sonar til web_search"
read_when:
  - Du vil bruge Perplexity Sonar til websøgning
  - Du har brug for PERPLEXITY_API_KEY eller OpenRouter-opsætning
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw kan bruge Perplexity Sonar til `web_search` værktøj. Du kan forbinde
via Perplexity’s direkte API eller via OpenRouter.

## API-muligheder

### Perplexity (direkte)

- Basis-URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- Miljøvariabel: `PERPLEXITY_API_KEY`

### OpenRouter (alternativ)

- Basis-URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Miljøvariabel: `OPENROUTER_API_KEY`
- Understøtter forudbetalte/krypto-kreditter.

## Konfigurationseksempel

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

## Skift fra Brave

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

Hvis både `PERPLEXITY_API_KEY` og `OPENROUTER_API_KEY` er sat, skal du angive
`tools.web.search.perplexity.baseUrl` (eller `tools.web.search.perplexity.apiKey`)
for at afklare.

Hvis der ikke er angivet en basis-URL, vælger OpenClaw en standard baseret på API-nøglens kilde:

- `PERPLEXITY_API_KEY` eller `pplx-...` → direkte Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` eller `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Ukendte nøgleformater → OpenRouter (sikkert fallback)

## Modeller

- `perplexity/sonar` — hurtig Q&A med websøgning
- `perplexity/sonar-pro` (standard) — flertrins-ræsonnement + websøgning
- `perplexity/sonar-reasoning-pro` — dybdegående research

Se [Web tools](/tools/web) for den fulde web_search-konfiguration.
