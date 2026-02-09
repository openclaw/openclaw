---
summary: "„Konfiguracja Perplexity Sonar dla web_search”"
read_when:
  - Chcesz używać Perplexity Sonar do wyszukiwania w sieci
  - Potrzebujesz PERPLEXITY_API_KEY lub konfiguracji OpenRouter
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw może używać Perplexity Sonar dla narzędzia `web_search`. Możesz połączyć się
przez bezpośrednie API Perplexity lub za pośrednictwem OpenRouter.

## Opcje API

### Perplexity (bezpośrednio)

- Bazowy URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- Zmienna środowiskowa: `PERPLEXITY_API_KEY`

### OpenRouter (alternatywa)

- Bazowy URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Zmienna środowiskowa: `OPENROUTER_API_KEY`
- Obsługuje kredyty przedpłacone/kryptowaluty.

## Przykład konfiguracji

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

## Przełączanie z Brave

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

Jeśli ustawione są zarówno `PERPLEXITY_API_KEY`, jak i `OPENROUTER_API_KEY`, ustaw
`tools.web.search.perplexity.baseUrl` (lub `tools.web.search.perplexity.apiKey`)
w celu jednoznacznego rozróżnienia.

Jeśli nie ustawiono bazowego URL, OpenClaw wybiera domyślny na podstawie źródła klucza API:

- `PERPLEXITY_API_KEY` lub `pplx-...` → bezpośrednie Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` lub `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Nieznane formaty kluczy → OpenRouter (bezpieczny fallback)

## Modele

- `perplexity/sonar` — szybkie Q&A z wyszukiwaniem w sieci
- `perplexity/sonar-pro` (domyślny) — wieloetapowe wnioskowanie + wyszukiwanie w sieci
- `perplexity/sonar-reasoning-pro` — dogłębne badania

Zobacz [Narzędzia web](/tools/web), aby uzyskać pełną konfigurację web_search.
