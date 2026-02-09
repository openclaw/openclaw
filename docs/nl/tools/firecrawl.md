---
summary: "Firecrawl-terugval voor web_fetch (anti-bot + gecachte extractie)"
read_when:
  - Je wilt webextractie met Firecrawl
  - Je hebt een Firecrawl API-sleutel nodig
  - Je wilt anti-botextractie voor web_fetch
title: "Firecrawl"
---

# Firecrawl

OpenClaw kan **Firecrawl** gebruiken als terugval-extractor voor `web_fetch`. Het is een gehoste
contentextractieservice die bot-omzeiling en caching ondersteunt, wat helpt
bij JS-zware sites of pagina’s die gewone HTTP-fetches blokkeren.

## Een API-sleutel verkrijgen

1. Maak een Firecrawl-account aan en genereer een API-sleutel.
2. Sla deze op in de config of stel `FIRECRAWL_API_KEY` in de Gateway-omgeving in.

## Firecrawl configureren

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

Notities:

- `firecrawl.enabled` staat standaard op true wanneer een API-sleutel aanwezig is.
- `maxAgeMs` bepaalt hoe oud gecachte resultaten mogen zijn (ms). Standaard is 2 dagen.

## Stealth / bot-omzeiling

Firecrawl biedt een **proxy-modus**-parameter voor bot-omzeiling (`basic`, `stealth` of `auto`).
OpenClaw gebruikt altijd `proxy: "auto"` plus `storeInCache: true` voor Firecrawl-verzoeken.
Als proxy wordt weggelaten, gebruikt Firecrawl standaard `auto`. `auto` probeert opnieuw met stealth-proxy’s als een basispoging faalt, wat meer credits kan gebruiken
dan scraping met alleen de basisoptie.

## Hoe `web_fetch` Firecrawl gebruikt

`web_fetch` extractievolgorde:

1. Readability (lokaal)
2. Firecrawl (indien geconfigureerd)
3. Basis HTML-opschoning (laatste terugval)

Zie [Web tools](/tools/web) voor de volledige configuratie van webtools.
