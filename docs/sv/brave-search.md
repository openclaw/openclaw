---
summary: "Konfigurering av Brave Search API för web_search"
read_when:
  - Du vill använda Brave Search för web_search
  - Du behöver en BRAVE_API_KEY eller plandetaljer
title: "Brave Search"
---

# Brave Search API

OpenClaw använder Brave Search som standardleverantör för `web_search`.

## Skaffa en API-nyckel

1. Skapa ett Brave Search API-konto på [https://brave.com/search/api/](https://brave.com/search/api/)
2. Välj planen **Data for Search** i instrumentpanelen och generera en API-nyckel.
3. Lagra nyckeln i konfig (rekommenderas) eller sätt `BRAVE_API_KEY` i Gateway-miljön.

## Konfigexempel

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Noteringar

- Planen Data for AI är **inte** kompatibel med `web_search`.
- Brave erbjuder ett kostnadsfritt nivå samt betalplaner; kontrollera Brave API-portalen för aktuella gränser.

Se [Webbverktyg](/tools/web) för den fullständiga web_search-konfigurationen.
