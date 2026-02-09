---
summary: "Websøgning + hentningsværktøjer (Brave Search API, Perplexity direkte/OpenRouter)"
read_when:
  - Du vil aktivere web_search eller web_fetch
  - Du har brug for opsætning af Brave Search API-nøgle
  - Du vil bruge Perplexity Sonar til websøgning
title: "Webværktøjer"
---

# Webværktøjer

OpenClaw leverer to letvægts webværktøjer:

- `web_search` — Søg på nettet via Brave Search API (standard) eller Perplexity Sonar (direkte eller via OpenRouter).
- `web_fetch` — HTTP-hentning + læsbar ekstraktion (HTML → markdown/tekst).

Dette er **ikke** browserautomatisering. For JS-tunge websteder eller logins, brug
[Browserværktøj](/tools/browser).

## Sådan virker det

- `web_search` kalder din konfigurerede udbyder og returnerer resultater.
  - **Brave** (standard): returnerer strukturerede resultater (titel, URL, uddrag).
  - **Perplexity**: returnerer AI-syntetiserede svar med citater fra web-søgning i realtid.
- Resultater caches pr. forespørgsel i 15 minutter (kan konfigureres).
- `web_fetch` gør en almindelig HTTP GET og udtrækker læsbart indhold
  (HTML → markdown/text). Det gør \*\* ikke\*\* udføre JavaScript.
- `web_fetch` er aktiveret som standard (medmindre det eksplicit deaktiveres).

## Valg af søgeudbyder

| Udbyder                                 | Fordele                                         | Ulemper                                    | API-nøgle                                       |
| --------------------------------------- | ----------------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| **Brave** (standard) | Hurtig, strukturerede resultater, gratis niveau | Traditionelle søgeresultater               | `BRAVE_API_KEY`                                 |
| **Perplexity**                          | AI-syntetiserede svar, citater, realtid         | Kræver Perplexity- eller OpenRouter-adgang | `OPENROUTER_API_KEY` eller `PERPLEXITY_API_KEY` |

Se [Brave Search-opsætning](/brave-search) og [Perplexity Sonar](/perplexity) for udbyderspecifikke detaljer.

Angiv udbyderen i konfigurationen:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

Eksempel: skift til Perplexity Sonar (direkte API):

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

## Sådan får du en Brave API-nøgle

1. Opret en Brave Search API-konto på [https://brave.com/search/api/](https://brave.com/search/api/)
2. Vælg planen **Data for Search** i dashboardet (ikke “Data for AI”) og generér en API-nøgle.
3. Kør `openclaw configure --section web` for at gemme nøglen i konfigurationen (anbefalet), eller sæt `BRAVE_API_KEY` i dit miljø.

Brave tilbyder et gratis niveau samt betalte planer; tjek Brave API-portalen for
aktuelle grænser og priser.

### Hvor nøglen sættes (anbefalet)

**Anbefalet:** kør `openclaw configure --section web`. Den gemmer nøglen i
`~/.openclaw/openclaw.json` under `tools.web.search.apiKey`.

**Miljø alternativ:** sæt `BRAVE_API_KEY` i Gateway proces
miljøet. For en gateway installation, skriv den i `~/.openclaw/.env` (eller dit
servicemiljø). See [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

## Brug af Perplexity (direkte eller via OpenRouter)

Perplexity Sonar modeller har indbyggede websøgning kapaciteter og returnere AI-syntetiserede
svar med citationer. Du kan bruge dem via OpenRouter (ingen kreditkort kræves - understøtter
crypto/prepaid).

### Sådan får du en OpenRouter API-nøgle

1. Opret en konto på [https://openrouter.ai/](https://openrouter.ai/)
2. Tilføj kreditter (understøtter krypto, forudbetaling eller kreditkort)
3. Generér en API-nøgle i dine kontoindstillinger

### Opsætning af Perplexity-søgning

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**Miljø alternativ:** sæt `OPENROUTER_API_KEY` eller `PERPLEXITY_API_KEY` i Gateway
miljøet. For en gateway installation, skriv den i `~/.openclaw/.env`.

Hvis der ikke er sat en base-URL, vælger OpenClaw en standard baseret på API-nøglens kilde:

- `PERPLEXITY_API_KEY` eller `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` eller `sk-or-...` → `https://openrouter.ai/api/v1`
- Ukendte nøgleformater → OpenRouter (sikker fallback)

### Tilgængelige Perplexity-modeller

| Model                                                | Beskrivelse                                   | Bedst til            |
| ---------------------------------------------------- | --------------------------------------------- | -------------------- |
| `perplexity/sonar`                                   | Hurtig Q&A med websøgning | Hurtige opslag       |
| `perplexity/sonar-pro` (standard) | Flertrinsræsonnement med websøgning           | Komplekse spørgsmål  |
| `perplexity/sonar-reasoning-pro`                     | Chain-of-thought-analyse                      | Dybdegående research |

## web_search

Søg på nettet ved hjælp af din konfigurerede udbyder.

### Krav

- `tools.web.search.enabled` må ikke være `false` (standard: aktiveret)
- API-nøgle til din valgte udbyder:
  - **Brave**: `BRAVE_API_KEY` eller `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY` eller `tools.web.search.perplexity.apiKey`

### Konfiguration

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### Værktøjsparametre

- `query` (påkrævet)
- `count` (1–10; standard fra konfiguration)
- `land` (valgfrit): landekode på 2 bogstaver for regionsspecifikke resultater (f.eks. "DE", "US", "ALL"). Hvis udeladt, Brave vælger sin standard region.
- `search_lang` (valgfri): ISO-sprogkode for søgeresultater (fx "de", "en", "fr")
- `ui_lang` (valgfri): ISO-sprogkode for UI-elementer
- `freshness` (valgfri, kun Brave): filtrér efter opdagelsestid (`pd`, `pw`, `pm`, `py` eller `YYYY-MM-DDtoYYYY-MM-DD`)

**Eksempler:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

Hent en URL og udtræk læsbart indhold.

### web_fetch-krav

- `tools.web.fetch.enabled` må ikke være `false` (standard: aktiveret)
- Valgfri Firecrawl-fallback: sæt `tools.web.fetch.firecrawl.apiKey` eller `FIRECRAWL_API_KEY`.

### web_fetch-konfiguration

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### web_fetch-værktøjsparametre

- `url` (påkrævet, kun http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (afkort lange sider)

Noter:

- `web_fetch` bruger først læsbarhed (main content extraction) og derefter Firecrawl (hvis konfigureret). Hvis begge mislykkes, returnerer værktøjet en fejl.
- Firecrawl-forespørgsler bruger bot-omgåelsestilstand og cacher resultater som standard.
- `web_fetch` sender en Chrome-lignende User-Agent og `Accept-Language` som standard; tilsidesæt `userAgent` om nødvendigt.
- `web_fetch` blokerer private/interne værtsnavne og genkontrollerer redirects (begræns med `maxRedirects`).
- `maxChars` begrænses til `tools.web.fetch.maxCharsCap`.
- `web_fetch` er best-effort-ekstraktion; nogle sider kræver browser-værktøjet.
- Se [Firecrawl](/tools/firecrawl) for opsætning af nøgler og servicedetaljer.
- Svar caches (standard 15 minutter) for at reducere gentagne hentninger.
- Hvis du bruger værktøjsprofiler/tilladelseslister, skal du tilføje `web_search`/`web_fetch` eller `group:web`.
- Hvis Brave-nøglen mangler, returnerer `web_search` et kort opsætningstip med et link til dokumentationen.
