---
summary: "Mga tool para sa web search + fetch (Brave Search API, Perplexity direct/OpenRouter)"
read_when:
  - Gusto mong i-enable ang web_search o web_fetch
  - Kailangan mo ng setup ng Brave Search API key
  - Gusto mong gamitin ang Perplexity Sonar para sa web search
title: "Mga Web Tool"
x-i18n:
  source_path: tools/web.md
  source_hash: c2f5e15bc78f09f7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:15Z
---

# Mga web tool

Nagpapadala ang OpenClaw ng dalawang magaan na web tool:

- `web_search` — Maghanap sa web gamit ang Brave Search API (default) o Perplexity Sonar (direct o via OpenRouter).
- `web_fetch` — HTTP fetch + readable extraction (HTML → markdown/text).

Hindi ito **browser automation**. Para sa mga site na mabigat sa JS o may login, gamitin ang
[Browser tool](/tools/browser).

## Paano ito gumagana

- Tumatawag ang `web_search` sa iyong naka-configure na provider at ibinabalik ang mga resulta.
  - **Brave** (default): nagbabalik ng structured na resulta (pamagat, URL, snippet).
  - **Perplexity**: nagbabalik ng AI-synthesized na mga sagot na may citations mula sa real-time web search.
- Ang mga resulta ay kino-cache ayon sa query sa loob ng 15 minuto (configurable).
- Gumagawa ang `web_fetch` ng plain HTTP GET at nag-e-extract ng readable na content
  (HTML → markdown/text). **Hindi** ito nagpapatakbo ng JavaScript.
- Ang `web_fetch` ay naka-enable bilang default (maliban kung tahasang i-disable).

## Pagpili ng search provider

| Provider            | Mga Bentahe                                   | Mga Kahinaan                                   | API Key                                     |
| ------------------- | --------------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| **Brave** (default) | Mabilis, structured na resulta, may free tier | Tradisyunal na search results                  | `BRAVE_API_KEY`                             |
| **Perplexity**      | AI-synthesized na sagot, citations, real-time | Kailangan ng access sa Perplexity o OpenRouter | `OPENROUTER_API_KEY` o `PERPLEXITY_API_KEY` |

Tingnan ang [Brave Search setup](/brave-search) at [Perplexity Sonar](/perplexity) para sa mga detalye na partikular sa provider.

Itakda ang provider sa config:

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

Halimbawa: lumipat sa Perplexity Sonar (direct API):

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

## Pagkuha ng Brave API key

1. Gumawa ng Brave Search API account sa [https://brave.com/search/api/](https://brave.com/search/api/)
2. Sa dashboard, piliin ang planong **Data for Search** (hindi “Data for AI”) at bumuo ng API key.
3. Patakbuhin ang `openclaw configure --section web` para i-store ang key sa config (inirerekomenda), o itakda ang `BRAVE_API_KEY` sa iyong environment.

Nagbibigay ang Brave ng free tier pati mga paid plan; tingnan ang Brave API portal para sa
kasalukuyang mga limitasyon at pagpepresyo.

### Saan itatakda ang key (inirerekomenda)

**Inirerekomenda:** patakbuhin ang `openclaw configure --section web`. Iiniimbak nito ang key sa
`~/.openclaw/openclaw.json` sa ilalim ng `tools.web.search.apiKey`.

**Alternatibo sa environment:** itakda ang `BRAVE_API_KEY` sa Gateway process
environment. Para sa gateway install, ilagay ito sa `~/.openclaw/.env` (o sa environment ng iyong
service). Tingnan ang [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

## Paggamit ng Perplexity (direct o via OpenRouter)

Ang mga Perplexity Sonar model ay may built-in na kakayahan sa web search at nagbabalik ng AI-synthesized
na mga sagot na may citations. Maaari mo silang gamitin via OpenRouter (hindi kailangan ng credit card — may suportang
crypto/prepaid).

### Pagkuha ng OpenRouter API key

1. Gumawa ng account sa [https://openrouter.ai/](https://openrouter.ai/)
2. Magdagdag ng credits (sumusuporta sa crypto, prepaid, o credit card)
3. Bumuo ng API key sa iyong account settings

### Pag-setup ng Perplexity search

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

**Alternatibo sa environment:** itakda ang `OPENROUTER_API_KEY` o `PERPLEXITY_API_KEY` sa Gateway
environment. Para sa gateway install, ilagay ito sa `~/.openclaw/.env`.

Kung walang base URL na nakatakda, pumipili ang OpenClaw ng default batay sa pinagmulan ng API key:

- `PERPLEXITY_API_KEY` o `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` o `sk-or-...` → `https://openrouter.ai/api/v1`
- Mga hindi kilalang format ng key → OpenRouter (ligtas na fallback)

### Mga available na Perplexity model

| Model                            | Paglalarawan                           | Pinakamainam para sa    |
| -------------------------------- | -------------------------------------- | ----------------------- |
| `perplexity/sonar`               | Mabilis na Q&A na may web search       | Mga quick lookup        |
| `perplexity/sonar-pro` (default) | Multi-step reasoning na may web search | Mga komplikadong tanong |
| `perplexity/sonar-reasoning-pro` | Chain-of-thought analysis              | Malalim na pananaliksik |

## web_search

Maghanap sa web gamit ang iyong naka-configure na provider.

### Mga kinakailangan

- Ang `tools.web.search.enabled` ay hindi dapat `false` (default: enabled)
- API key para sa iyong napiling provider:
  - **Brave**: `BRAVE_API_KEY` o `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, o `tools.web.search.perplexity.apiKey`

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

### Mga parameter ng tool

- `query` (kinakailangan)
- `count` (1–10; default mula sa config)
- `country` (opsyonal): 2-letter na country code para sa region-specific na mga resulta (hal., "DE", "US", "ALL"). Kapag hindi isinama, pipili ang Brave ng default nitong rehiyon.
- `search_lang` (opsyonal): ISO language code para sa mga search result (hal., "de", "en", "fr")
- `ui_lang` (opsyonal): ISO language code para sa mga UI element
- `freshness` (opsyonal, Brave lang): i-filter ayon sa discovery time (`pd`, `pw`, `pm`, `py`, o `YYYY-MM-DDtoYYYY-MM-DD`)

**Mga halimbawa:**

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

Mag-fetch ng URL at mag-extract ng readable na content.

### Mga kinakailangan ng web_fetch

- Ang `tools.web.fetch.enabled` ay hindi dapat `false` (default: enabled)
- Opsyonal na Firecrawl fallback: itakda ang `tools.web.fetch.firecrawl.apiKey` o `FIRECRAWL_API_KEY`.

### web_fetch config

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

### Mga parameter ng web_fetch tool

- `url` (kinakailangan, http/https lang)
- `extractMode` (`markdown` | `text`)
- `maxChars` (i-truncate ang mahahabang pahina)

Mga tala:

- Ginagamit ng `web_fetch` ang Readability (main-content extraction) muna, pagkatapos ay Firecrawl (kung naka-configure). Kapag parehong pumalya, magbabalik ng error ang tool.
- Ang mga Firecrawl request ay gumagamit ng bot-circumvention mode at kino-cache ang mga resulta bilang default.
- Ang `web_fetch` ay nagpapadala ng Chrome-like User-Agent at `Accept-Language` bilang default; i-override ang `userAgent` kung kailangan.
- Ang `web_fetch` ay nagba-block ng private/internal na mga hostname at muling sine-check ang mga redirect (limitahan gamit ang `maxRedirects`).
- Ang `maxChars` ay kino-clamp sa `tools.web.fetch.maxCharsCap`.
- Ang `web_fetch` ay best-effort extraction; may ilang site na mangangailangan ng browser tool.
- Tingnan ang [Firecrawl](/tools/firecrawl) para sa setup ng key at mga detalye ng serbisyo.
- Ang mga tugon ay kino-cache (default 15 minuto) para mabawasan ang paulit-ulit na fetch.
- Kung gumagamit ka ng mga tool profile/allowlist, idagdag ang `web_search`/`web_fetch` o `group:web`.
- Kapag nawawala ang Brave key, magbabalik ang `web_search` ng maikling setup hint na may link sa docs.
