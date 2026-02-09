---
summary: "Webzoek- en ophaaltools (Brave Search API, Perplexity direct/OpenRouter)"
read_when:
  - Je wilt web_search of web_fetch inschakelen
  - Je hebt een Brave Search API-sleutel nodig
  - Je wilt Perplexity Sonar gebruiken voor webzoekopdrachten
title: "Webtools"
---

# Webtools

OpenClaw levert twee lichtgewicht webtools:

- `web_search` — Zoek op het web via de Brave Search API (standaard) of Perplexity Sonar (direct of via OpenRouter).
- `web_fetch` — HTTP-ophalen + leesbare extractie (HTML → markdown/tekst).

Dit is **geen** browserautomatisering. Voor JS-zware sites of inlogflows, gebruik de
[Browser tool](/tools/browser).

## Hoe het werkt

- `web_search` roept je geconfigureerde provider aan en retourneert resultaten.
  - **Brave** (standaard): retourneert gestructureerde resultaten (titel, URL, snippet).
  - **Perplexity**: retourneert door AI gesynthetiseerde antwoorden met citaties uit realtime webzoekopdrachten.
- Resultaten worden per query 15 minuten gecachet (configureerbaar).
- `web_fetch` doet een eenvoudige HTTP GET en extraheert leesbare inhoud
  (HTML → markdown/tekst). Het voert **geen** JavaScript uit.
- `web_fetch` is standaard ingeschakeld (tenzij expliciet uitgeschakeld).

## Een zoekprovider kiezen

| Provider                                 | Voordelen                                          | Nadelen                                   | API-sleutel                                  |
| ---------------------------------------- | -------------------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| **Brave** (standaard) | Snel, gestructureerde resultaten, gratis tier      | Traditionele zoekresultaten               | `BRAVE_API_KEY`                              |
| **Perplexity**                           | AI-gesynthetiseerde antwoorden, citaties, realtime | Vereist Perplexity- of OpenRouter-toegang | `OPENROUTER_API_KEY` of `PERPLEXITY_API_KEY` |

Zie [Brave Search setup](/brave-search) en [Perplexity Sonar](/perplexity) voor providerspecifieke details.

Stel de provider in via de config:

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

Voorbeeld: overschakelen naar Perplexity Sonar (directe API):

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

## Een Brave API-sleutel verkrijgen

1. Maak een Brave Search API-account aan op [https://brave.com/search/api/](https://brave.com/search/api/)
2. Kies in het dashboard het **Data for Search**-abonnement (niet “Data for AI”) en genereer een API-sleutel.
3. Voer `openclaw configure --section web` uit om de sleutel in de config op te slaan (aanbevolen), of stel `BRAVE_API_KEY` in in je omgeving.

Brave biedt een gratis tier plus betaalde abonnementen; controleer het Brave API-portal voor de
actuele limieten en prijzen.

### Waar de sleutel instellen (aanbevolen)

**Aanbevolen:** voer `openclaw configure --section web` uit. Dit slaat de sleutel op in
`~/.openclaw/openclaw.json` onder `tools.web.search.apiKey`.

**Omgevingsalternatief:** stel `BRAVE_API_KEY` in in de Gateway-procesomgeving. Voor een gateway-installatie, plaats dit in `~/.openclaw/.env` (of je
service-omgeving). Zie [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

## Perplexity gebruiken (direct of via OpenRouter)

Perplexity Sonar-modellen hebben ingebouwde webzoekmogelijkheden en retourneren door AI
gesynthetiseerde antwoorden met citaties. Je kunt ze gebruiken via OpenRouter (geen creditcard
vereist — ondersteunt crypto/prepaid).

### Een OpenRouter API-sleutel verkrijgen

1. Maak een account aan op [https://openrouter.ai/](https://openrouter.ai/)
2. Voeg credits toe (ondersteunt crypto, prepaid of creditcard)
3. Genereer een API-sleutel in je accountinstellingen

### Perplexity-zoekopdrachten instellen

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

**Omgevingsalternatief:** stel `OPENROUTER_API_KEY` of `PERPLEXITY_API_KEY` in in de Gateway-
omgeving. Voor een gateway-installatie, plaats dit in `~/.openclaw/.env`.

Als er geen base-URL is ingesteld, kiest OpenClaw een standaard op basis van de bron van de API-sleutel:

- `PERPLEXITY_API_KEY` of `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` of `sk-or-...` → `https://openrouter.ai/api/v1`
- Onbekende sleutelindelingen → OpenRouter (veilige fallback)

### Beschikbare Perplexity-modellen

| Model                                                 | Beschrijving                                         | Beste voor            |
| ----------------------------------------------------- | ---------------------------------------------------- | --------------------- |
| `perplexity/sonar`                                    | Snelle Q&A met webzoekopdrachten | Snelle zoekopdrachten |
| `perplexity/sonar-pro` (standaard) | Meertraps redeneren met webzoekopdrachten            | Complexe vragen       |
| `perplexity/sonar-reasoning-pro`                      | Chain-of-thought-analyse                             | Diepgaand onderzoek   |

## web_search

Zoek op het web met je geconfigureerde provider.

### Provideropties

- `tools.web.search.enabled` mag niet `false` zijn (standaard: ingeschakeld)
- API-sleutel voor je gekozen provider:
  - **Brave**: `BRAVE_API_KEY` of `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY` of `tools.web.search.perplexity.apiKey`

### Config

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

### Toolparameters

- `query` (vereist)
- `count` (1–10; standaard uit config)
- `country` (optioneel): 2-letterige landcode voor regiogebonden resultaten (bijv. "DE", "US", "ALL"). Indien weggelaten, kiest Brave zijn standaardregio.
- `search_lang` (optioneel): ISO-taalcode voor zoekresultaten (bijv. "de", "en", "fr")
- `ui_lang` (optioneel): ISO-taalcode voor UI-elementen
- `freshness` (optioneel, alleen Brave): filter op ontdekkingstijd (`pd`, `pw`, `pm`, `py` of `YYYY-MM-DDtoYYYY-MM-DD`)

**Voorbeelden:**

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

Haal een URL op en extraheer leesbare inhoud.

### web_fetch-vereisten

- `tools.web.fetch.enabled` mag niet `false` zijn (standaard: ingeschakeld)
- Optionele Firecrawl-fallback: stel `tools.web.fetch.firecrawl.apiKey` of `FIRECRAWL_API_KEY` in.

### web_fetch-config

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

### web_fetch-toolparameters

- `url` (vereist, alleen http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (lange pagina’s afkappen)

Notities:

- `web_fetch` gebruikt eerst Readability (extractie van hoofdinhoud), daarna Firecrawl (indien geconfigureerd). Als beide falen, retourneert de tool een fout.
- Firecrawl-verzoeken gebruiken standaard bot-omzeilingsmodus en cachen resultaten.
- `web_fetch` verstuurt standaard een Chrome-achtige User-Agent en `Accept-Language`; overschrijf `userAgent` indien nodig.
- `web_fetch` blokkeert private/interne hostnamen en controleert redirects opnieuw (beperk met `maxRedirects`).
- `maxChars` wordt begrensd op `tools.web.fetch.maxCharsCap`.
- `web_fetch` is best-effort-extractie; sommige sites hebben de browsertool nodig.
- Zie [Firecrawl](/tools/firecrawl) voor sleutelinstelling en servicedetails.
- Antwoorden worden gecachet (standaard 15 minuten) om herhaalde fetches te verminderen.
- Als je toolprofielen/toegestane lijsten gebruikt, voeg `web_search`/`web_fetch` of `group:web` toe.
- Als de Brave-sleutel ontbreekt, retourneert `web_search` een korte instelhint met een documentatielink.
