---
summary: "Verktyg för webbsökning och hämtning (Brave Search API, Perplexity direkt/OpenRouter)"
read_when:
  - Du vill aktivera web_search eller web_fetch
  - Du behöver konfigurera en Brave Search API-nyckel
  - Du vill använda Perplexity Sonar för webbsökning
title: "Webbverktyg"
---

# Webbverktyg

OpenClaw levereras med två lättviktiga webbverktyg:

- `web_search` — Sök på webben via Brave Search API (standard) eller Perplexity Sonar (direkt eller via OpenRouter).
- `web_fetch` — HTTP-hämtning + extrahering av läsbart innehåll (HTML → markdown/text).

Dessa är **inte** webbläsarautomatisering. För JS-tunga webbplatser eller inloggningar, använd
[Webbläsarverktyg](/tools/browser).

## Hur det fungerar

- `web_search` anropar din konfigurerade leverantör och returnerar resultat.
  - **Brave** (standard): returnerar strukturerade resultat (titel, URL, utdrag).
  - **Perplexity**: returnerar AI-syntetiserade svar med citeringar från webbsökning i realtid.
- Resultat cachas per fråga i 15 minuter (konfigurerbart).
- `web_fetch` gör en vanlig HTTP GET och extraherar läsbart innehåll
  (HTML → markdown/text). Det utför **inte** JavaScript.
- `web_fetch` är aktiverat som standard (om det inte uttryckligen inaktiveras).

## Välja sökleverantör

| Leverantör                              | Fördelar                                   | Nackdelar                                   | API-nyckel                                      |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------- | ----------------------------------------------- |
| **Brave** (standard) | Snabbt, strukturerade resultat, gratisnivå | Traditionella sökresultat                   | `BRAVE_API_KEY`                                 |
| **Perplexity**                          | AI-syntetiserade svar, citeringar, realtid | Kräver Perplexity- eller OpenRouter-åtkomst | `OPENROUTER_API_KEY` eller `PERPLEXITY_API_KEY` |

Se [Brave Search setup](/brave-search) och [Perplexity Sonar](/perplexity) för leverantörsspecifika detaljer.

Ställ in leverantören i konfig:

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

Exempel: byt till Perplexity Sonar (direkt API):

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

## Skaffa en Brave API-nyckel

1. Skapa ett Brave Search API-konto på [https://brave.com/search/api/](https://brave.com/search/api/)
2. Välj planen **Data for Search** i kontrollpanelen (inte ”Data for AI”) och generera en API-nyckel.
3. Kör `openclaw configure --section web` för att lagra nyckeln i konfig (rekommenderas), eller sätt `BRAVE_API_KEY` i din miljö.

Brave erbjuder en gratisnivå samt betalplaner; kontrollera Brave API-portalen för
aktuella gränser och priser.

### Var du sätter nyckeln (rekommenderat)

**Rekommenderad:** kör `openclaw konfigurera --section web`. Den lagrar nyckeln i
`~/.openclaw/openclaw.json` under `tools.web.search.apiKey`.

**Miljöalternativ:** sätt `BRAVE_API_KEY` i Gateway-processen
miljön. För en gateway installera, sätt den i `~/.openclaw/.env` (eller din
servicemiljö). See [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

## Använda Perplexity (direkt eller via OpenRouter)

Perplexity Sonar modeller har inbyggda sökfunktioner och avkastning AI-syntetiserade
svar med citeringar. Du kan använda dem via OpenRouter (inget kreditkort krävs - stöder
crypto/prepaid).

### Skaffa en OpenRouter API-nyckel

1. Skapa ett konto på [https://openrouter.ai/](https://openrouter.ai/)
2. Lägg till saldo (stödjer krypto, förbetalt eller kreditkort)
3. Generera en API-nyckel i kontoinställningarna

### Konfigurera Perplexity-sökning

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

**Miljöalternativ:** sätt `OPENROUTER_API_KEY` eller `PERPLEXITY_API_KEY` i Gateway
miljön. För en gateway installera, sätt den i `~/.openclaw/.env`.

Om ingen bas-URL är satt väljer OpenClaw ett standardvärde baserat på API-nyckelns källa:

- `PERPLEXITY_API_KEY` eller `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` eller `sk-or-...` → `https://openrouter.ai/api/v1`
- Okända nyckelformat → OpenRouter (säker fallback)

### Tillgängliga Perplexity-modeller

| Modell                                               | Beskrivning                                   | Bäst för        |
| ---------------------------------------------------- | --------------------------------------------- | --------------- |
| `perplexity/sonar`                                   | Snabb Q&A med webbsökning | Snabba uppslag  |
| `perplexity/sonar-pro` (standard) | Flerstegsresonemang med webbsökning           | Komplexa frågor |
| `perplexity/sonar-reasoning-pro`                     | Chain-of-thought-analys                       | Djup research   |

## web_search

Sök på webben med din konfigurerade leverantör.

### Krav

- `tools.web.search.enabled` får inte vara `false` (standard: aktiverad)
- API-nyckel för vald leverantör:
  - **Brave**: `BRAVE_API_KEY` eller `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY` eller `tools.web.search.perplexity.apiKey`

### Konfig

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

### Verktygsparametrar

- `query` (obligatorisk)
- `count` (1–10; standard från konfig)
- `country` (valfritt): 2 bokstäver landskod för regionspecifika resultat (t.ex., "DE", "US", "ALL"). Om den utelämnas väljer modig sin standardregion.
- `search_lang` (valfritt): ISO språkkod för sökresultat (t.ex., "de", "en", "fr")
- `ui_lang` (valfri): ISO-språkkod för UI-element
- `freshness` (valfri, endast Brave): filtrera efter upptäcktstid (`pd`, `pw`, `pm`, `py` eller `YYYY-MM-DDtoYYYY-MM-DD`)

**Exempel:**

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

Hämta en URL och extrahera läsbart innehåll.

### Krav för web_fetch

- `tools.web.fetch.enabled` får inte vara `false` (standard: aktiverad)
- Valfri Firecrawl-fallback: sätt `tools.web.fetch.firecrawl.apiKey` eller `FIRECRAWL_API_KEY`.

### web_fetch-konfig

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

### Parametrar för web_fetch-verktyget

- `url` (obligatorisk, endast http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (korta ned långa sidor)

Noteringar:

- `web_fetch` använder läsbarhet (huvudinnehållsextraktion) först och sedan Firecrawl (om konfigurerad). Om båda misslyckas, returnerar verktyget ett fel.
- Firecrawl-anrop använder bot-kringgående läge och cachar resultat som standard.
- `web_fetch` skickar en Chrome-liknande User-Agent och `Accept-Language` som standard; åsidosätt `userAgent` vid behov.
- `web_fetch` blockerar privata/interna värdnamn och kontrollerar omdirigeringar igen (begränsa med `maxRedirects`).
- `maxChars` begränsas till `tools.web.fetch.maxCharsCap`.
- `web_fetch` är bästa möjliga extrahering; vissa webbplatser kräver browser tool.
- Se [Firecrawl](/tools/firecrawl) för nyckelkonfigurering och tjänstedetaljer.
- Svar cachas (standard 15 minuter) för att minska upprepade hämtningar.
- Om du använder verktygsprofiler/tillåtelselistor, lägg till `web_search`/`web_fetch` eller `group:web`.
- Om Brave-nyckeln saknas returnerar `web_search` en kort installationshint med en dokumentationslänk.
