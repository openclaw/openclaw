---
summary: "Perplexity Sonar-instelling voor web_search"
read_when:
  - Je wilt Perplexity Sonar gebruiken voor web search
  - Je hebt PERPLEXITY_API_KEY of een OpenRouter-configuratie nodig
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw kan Perplexity Sonar gebruiken voor de `web_search` tool. Je kunt verbinden
via de directe API van Perplexity of via OpenRouter.

## API-opties

### Perplexity (direct)

- Basis-URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- Omgevingsvariabele: `PERPLEXITY_API_KEY`

### OpenRouter (alternatief)

- Basis-URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Omgevingsvariabele: `OPENROUTER_API_KEY`
- Ondersteunt prepaid-/crypto-tegoeden.

## Configuratievoorbeeld

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

## Overstappen van Brave

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

Als zowel `PERPLEXITY_API_KEY` als `OPENROUTER_API_KEY` zijn ingesteld, stel
`tools.web.search.perplexity.baseUrl` (of `tools.web.search.perplexity.apiKey`)
in om te verduidelijken.

Als er geen basis-URL is ingesteld, kiest OpenClaw een standaard op basis van de API-sleutelbron:

- `PERPLEXITY_API_KEY` of `pplx-...` → directe Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` of `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Onbekende sleutelindelingen → OpenRouter (veilige fallback)

## Modellen

- `perplexity/sonar` — snelle Q&A met web search
- `perplexity/sonar-pro` (standaard) — meerstapsredenering + web search
- `perplexity/sonar-reasoning-pro` — diepgaand onderzoek

Zie [Web tools](/tools/web) voor de volledige web_search-configuratie.
