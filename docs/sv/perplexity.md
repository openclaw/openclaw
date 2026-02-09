---
summary: "Konfiguration av Perplexity Sonar för web_search"
read_when:
  - Du vill använda Perplexity Sonar för webbsökning
  - Du behöver PERPLEXITY_API_KEY eller OpenRouter-konfiguration
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw kan använda Perplexity Sonar för verktyget `web_search`. Du kan ansluta
via Perplexitys direkta API eller via OpenRouter.

## API-alternativ

### Perplexity (direkt)

- Bas-URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- Miljövariabel: `PERPLEXITY_API_KEY`

### OpenRouter (alternativ)

- Bas-URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Miljövariabel: `OPENROUTER_API_KEY`
- Stöder förbetalda/kryptokrediter.

## Konfigexempel

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

## Byta från Brave

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

Om både `PERPLEXITY_API_KEY` och `OPENROUTER_API_KEY` är satta, ange
`tools.web.search.perplexity.baseUrl` (eller `tools.web.search.perplexity.apiKey`)
för att undanröja tvetydighet.

Om ingen bas-URL är satt väljer OpenClaw ett standardvärde baserat på API-nyckelns källa:

- `PERPLEXITY_API_KEY` eller `pplx-...` → direkt Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` eller `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Okända nyckelformat → OpenRouter (säker fallback)

## Modeller

- `perplexity/sonar` — snabb Q&A med webbsökning
- `perplexity/sonar-pro` (standard) — flerstegsresonemang + webbsökning
- `perplexity/sonar-reasoning-pro` — djup forskning

Se [Web tools](/tools/web) för fullständig konfiguration av web_search.
