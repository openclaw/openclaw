---
summary: "Firecrawl-reserv för web_fetch (anti-bot + cachad extraktion)"
read_when:
  - Du vill ha webextraktion med Firecrawl-stöd
  - Du behöver en Firecrawl API-nyckel
  - Du vill ha anti-bot-extraktion för web_fetch
title: "Firecrawl"
x-i18n:
  source_path: tools/firecrawl.md
  source_hash: 08a7ad45b41af412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:37Z
---

# Firecrawl

OpenClaw kan använda **Firecrawl** som en reservextraktor för `web_fetch`. Det är en värdbaserad
tjänst för innehållsextraktion som stöder kringgående av bot-skydd och cachning, vilket hjälper
med JS-tunga webbplatser eller sidor som blockerar vanliga HTTP-hämtningar.

## Skaffa en API-nyckel

1. Skapa ett Firecrawl-konto och generera en API-nyckel.
2. Spara den i konfig eller sätt `FIRECRAWL_API_KEY` i gateway-miljön.

## Konfigurera Firecrawl

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

Noteringar:

- `firecrawl.enabled` är som standard true när en API-nyckel finns.
- `maxAgeMs` styr hur gamla cachade resultat får vara (ms). Standard är 2 dagar.

## Stealth / kringgående av bot-skydd

Firecrawl exponerar en parameter för **proxy-läge** för kringgående av bot-skydd (`basic`, `stealth` eller `auto`).
OpenClaw använder alltid `proxy: "auto"` plus `storeInCache: true` för Firecrawl-förfrågningar.
Om proxy utelämnas använder Firecrawl som standard `auto`. `auto` försöker igen med stealth-proxys om ett grundläggande försök misslyckas, vilket kan använda fler krediter
än endast grundläggande skrapning.

## Hur `web_fetch` använder Firecrawl

`web_fetch` extraktionsordning:

1. Readability (lokalt)
2. Firecrawl (om konfigurerat)
3. Grundläggande HTML-rensning (sista reserv)

Se [Web tools](/tools/web) för den fullständiga konfigurationen av webbverktyg.
