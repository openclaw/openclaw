---
summary: "Firecrawl-fallback for web_fetch (anti-bot + cachet udtræk)"
read_when:
  - Du vil have Firecrawl-baseret webudtræk
  - Du har brug for en Firecrawl API-nøgle
  - Du vil have anti-bot-udtræk for web_fetch
title: "Firecrawl"
x-i18n:
  source_path: tools/firecrawl.md
  source_hash: 08a7ad45b41af412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:40Z
---

# Firecrawl

OpenClaw kan bruge **Firecrawl** som fallback-ekstraktor for `web_fetch`. Det er en hostet
indholdsudtrækstjeneste, der understøtter bot-omgåelse og caching, hvilket hjælper
med JS-tunge sites eller sider, der blokerer almindelige HTTP-forespørgsler.

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
- `maxAgeMs` styrer, hvor gamle cachede resultater må være (ms). Standard er 2 dage.

## Stealth / bot-omgåelse

Firecrawl eksponerer en **proxy mode**-parameter til bot-omgåelse (`basic`, `stealth` eller `auto`).
OpenClaw bruger altid `proxy: "auto"` plus `storeInCache: true` til Firecrawl-forespørgsler.
Hvis proxy udelades, bruger Firecrawl som standard `auto`. `auto` prøver igen med stealth-proxyer, hvis et grundlæggende forsøg fejler, hvilket kan bruge flere credits
end scraping med kun basic.

## Sådan bruger `web_fetch` Firecrawl

`web_fetch` udtræksrækkefølge:

1. Readability (lokalt)
2. Firecrawl (hvis konfigureret)
3. Grundlæggende HTML-oprydning (sidste fallback)

Se [Web tools](/tools/web) for den fulde opsætning af webværktøjer.
