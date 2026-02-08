---
summary: "Setup ng Perplexity Sonar para sa web_search"
read_when:
  - Gusto mong gamitin ang Perplexity Sonar para sa web search
  - Kailangan mo ng PERPLEXITY_API_KEY o setup ng OpenRouter
title: "Perplexity Sonar"
x-i18n:
  source_path: perplexity.md
  source_hash: f6c9824ad9bebe38
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:36Z
---

# Perplexity Sonar

Maaaring gumamit ang OpenClaw ng Perplexity Sonar para sa tool na `web_search`. Maaari kang kumonekta
sa pamamagitan ng direktang API ng Perplexity o sa pamamagitan ng OpenRouter.

## Mga opsyon sa API

### Perplexity (direkta)

- Base URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- Environment variable: `PERPLEXITY_API_KEY`

### OpenRouter (alternatibo)

- Base URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Environment variable: `OPENROUTER_API_KEY`
- Sinusuportahan ang prepaid/crypto credits.

## Halimbawa ng config

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

## Paglipat mula sa Brave

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

Kung parehong naka-set ang `PERPLEXITY_API_KEY` at `OPENROUTER_API_KEY`, i-set ang
`tools.web.search.perplexity.baseUrl` (o `tools.web.search.perplexity.apiKey`)
para ma-disambiguate.

Kung walang naka-set na base URL, pumipili ang OpenClaw ng default batay sa pinagmulan ng API key:

- `PERPLEXITY_API_KEY` o `pplx-...` → direktang Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` o `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Hindi kilalang mga format ng key → OpenRouter (ligtas na fallback)

## Mga model

- `perplexity/sonar` — mabilis na Q&A na may web search
- `perplexity/sonar-pro` (default) — multi-step reasoning + web search
- `perplexity/sonar-reasoning-pro` — malalim na pananaliksik

Tingnan ang [Web tools](/tools/web) para sa kumpletong konpigurasyon ng web_search.
