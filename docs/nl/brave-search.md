---
summary: "Installatie van de Brave Search API voor web_search"
read_when:
  - Je wilt Brave Search gebruiken voor web_search
  - Je hebt een BRAVE_API_KEY of plandetails nodig
title: "Brave Search"
---

# Brave Search API

OpenClaw gebruikt Brave Search als de standaardprovider voor `web_search`.

## Een API-sleutel verkrijgen

1. Maak een Brave Search API-account aan op [https://brave.com/search/api/](https://brave.com/search/api/)
2. Kies in het dashboard het **Data for Search**-plan en genereer een API-sleutel.
3. Sla de sleutel op in de config (aanbevolen) of stel `BRAVE_API_KEY` in binnen de Gateway-omgeving.

## Config-voorbeeld

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

## Notities

- Het Data for AI-plan is **niet** compatibel met `web_search`.
- Brave biedt een gratis niveau plus betaalde plannen; controleer het Brave API-portaal voor de actuele limieten.

Zie [Web tools](/tools/web) voor de volledige web_search-configuratie.
