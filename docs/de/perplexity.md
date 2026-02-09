---
summary: "„Perplexity-Sonar-Einrichtung für web_search“"
read_when:
  - Sie möchten Perplexity Sonar für die Websuche verwenden
  - Sie benötigen PERPLEXITY_API_KEY oder eine OpenRouter-Einrichtung
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw kann Perplexity Sonar für das Werkzeug `web_search` verwenden. Sie können
sich entweder über die direkte API von Perplexity oder über OpenRouter verbinden.

## API-Optionen

### Perplexity (direkt)

- Basis-URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- Umgebungsvariable: `PERPLEXITY_API_KEY`

### OpenRouter (Alternative)

- Basis-URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Umgebungsvariable: `OPENROUTER_API_KEY`
- Unterstützt Prepaid-/Krypto-Guthaben.

## Konfigurationsbeispiel

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

## Wechsel von Brave

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

Wenn sowohl `PERPLEXITY_API_KEY` als auch `OPENROUTER_API_KEY` gesetzt sind, setzen Sie
`tools.web.search.perplexity.baseUrl` (oder `tools.web.search.perplexity.apiKey`),
um die Zuordnung eindeutig festzulegen.

Wenn keine Basis-URL gesetzt ist, wählt OpenClaw standardmäßig eine auf Grundlage der API-Schlüsselquelle:

- `PERPLEXITY_API_KEY` oder `pplx-...` → direktes Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` oder `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Unbekannte Schlüsselformate → OpenRouter (sicherer Fallback)

## Modelle

- `perplexity/sonar` — schnelle Q&A mit Websuche
- `perplexity/sonar-pro` (Standard) — mehrstufige Schlussfolgerung + Websuche
- `perplexity/sonar-reasoning-pro` — tiefgehende Recherche

Siehe [Web-Tools](/tools/web) für die vollständige web_search-Konfiguration.
