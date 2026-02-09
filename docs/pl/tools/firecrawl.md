---
summary: "„Zapasowe użycie Firecrawl dla web_fetch (anty‑bot + ekstrakcja z cache)”"
read_when:
  - Chcesz ekstrakcję WWW opartą na Firecrawl
  - Potrzebujesz klucza API Firecrawl
  - Chcesz ekstrakcję anty‑bot dla web_fetch
title: "Firecrawl"
---

# Firecrawl

OpenClaw może używać **Firecrawl** jako zapasowego ekstraktora dla `web_fetch`. Jest to hostowana
usługa ekstrakcji treści, która obsługuje omijanie zabezpieczeń botów oraz cache’owanie, co pomaga
w przypadku witryn opartych na JS lub stron blokujących zwykłe pobrania HTTP.

## Uzyskaj klucz API

1. Utwórz konto Firecrawl i wygeneruj klucz API.
2. Zapisz go w konfiguracji lub ustaw `FIRECRAWL_API_KEY` w środowisku Gateway.

## Skonfiguruj Firecrawl

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

Uwagi:

- `firecrawl.enabled` domyślnie ma wartość true, gdy obecny jest klucz API.
- `maxAgeMs` kontroluje, jak stare mogą być wyniki z cache (ms). Wartość domyślna to 2 dni.

## Tryb stealth / omijanie botów

Firecrawl udostępnia parametr **proxy mode** do omijania botów (`basic`, `stealth` lub `auto`).
OpenClaw zawsze używa `proxy: "auto"` wraz z `storeInCache: true` dla żądań Firecrawl.
Jeśli proxy zostanie pominięte, Firecrawl domyślnie używa `auto`. `auto` ponawia próby z użyciem proxy stealth, jeśli podstawowa próba się nie powiedzie, co może zużywać więcej kredytów
niż skrobanie wyłącznie w trybie podstawowym.

## Jak `web_fetch` używa Firecrawl

Kolejność ekstrakcji `web_fetch`:

1. Readability (lokalnie)
2. Firecrawl (jeśli skonfigurowany)
3. Podstawowe czyszczenie HTML (ostatnia rezerwa)

Zobacz [Narzędzia webowe](/tools/web), aby zapoznać się z pełną konfiguracją narzędzi WWW.
