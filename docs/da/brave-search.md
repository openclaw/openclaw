---
summary: "Opsætning af Brave Search API til web_search"
read_when:
  - Du vil bruge Brave Search til web_search
  - Du har brug for en BRAVE_API_KEY eller plandetaljer
title: "Brave Search"
---

# Brave Search API

OpenClaw bruger Brave Search som standardudbyder til `web_search`.

## Få en API-nøgle

1. Opret en Brave Search API-konto på [https://brave.com/search/api/](https://brave.com/search/api/)
2. Vælg **Data for Search**-planen i dashboardet, og generér en API-nøgle.
3. Gem nøglen i konfigurationen (anbefalet) eller sæt `BRAVE_API_KEY` i Gateway-miljøet.

## Konfigurationseksempel

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

## Noter

- Data for AI-planen er **ikke** kompatibel med `web_search`.
- Brave tilbyder et gratis niveau samt betalte planer; se Brave API-portalen for aktuelle grænser.

Se [Web tools](/tools/web) for den fulde web_search-konfiguration.
