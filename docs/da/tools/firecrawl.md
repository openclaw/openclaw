---
summary: "Firecrawl-fallback for web_fetch (anti-bot + cachet udtræk)"
read_when:
  - Du vil have Firecrawl-baseret webudtræk
  - Du har brug for en Firecrawl API-nøgle
  - Du vil have anti-bot-udtræk for web_fetch
title: "Firecrawl"
---

# Firecrawl

OpenClaw kan bruge **Firecrawl** som en fallback emhætte til `web_fetch`. Det er en hosted
indhold udvinding service, der understøtter bot omgåelse og caching, som hjælper
med JS-tunge websteder eller sider, der blokerer almindeligt HTTP henter.

## Få en API-nøgle

1. Opret en Firecrawl-konto og generér en API-nøgle.
2. Gem den i konfigurationen eller sæt `FIRECRAWL_API_KEY` i gateway-miljøet.

## Konfigurér Firecrawl

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

Noter:

- `firecrawl.enabled` er som standard true, når en API-nøgle er til stede.
- `maxAgeMs` styrer hvor gamle cachede resultater kan være (ms). Standard er 2 dage.

## Stealth / bot-omgåelse

Firecrawl udsætter en **proxy-tilstand** parameter for bot omgåelse (`basic`, `stealth`, eller `auto`).
OpenClaw bruger altid `proxy: "auto"` plus `storeInCache: true` for Firecrawl anmodninger.
Hvis proxy udelades, er Firecrawl standard `auto`. `auto` retter sig med stealth fuldmagter, hvis et grundlæggende forsøg mislykkes, som kan bruge flere kreditter
end grundlæggende skrabning.

## Sådan bruger `web_fetch` Firecrawl

`web_fetch` udtræksrækkefølge:

1. Readability (lokalt)
2. Firecrawl (hvis konfigureret)
3. Grundlæggende HTML-oprydning (sidste fallback)

Se [Web tools](/tools/web) for den fulde opsætning af webværktøjer.
