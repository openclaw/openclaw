---
summary: "Web search + fetch tools (Brave Search API)"
read_when:
  - You want to enable web_search or web_fetch
  - You need Brave Search API key setup
---

# Web tools

Clawdbot ships two lightweight web tools:

- `web_search` — Brave Search API queries (fast, structured results).
- `web_fetch` — HTTP fetch + readable extraction (HTML → markdown/text).

These are **not** browser automation. For JS-heavy sites or logins, use the
[Browser tool](/tools/browser).

## How it works

- `web_search` calls Brave’s Search API and returns structured results
  (title, URL, snippet). No browser is involved.
- Results are cached by query for 15 minutes (configurable).
- `web_fetch` does a plain HTTP GET and extracts readable content
  (HTML → markdown/text). It does **not** execute JavaScript.
- `web_fetch` is enabled by default (unless explicitly disabled).

## Getting a Brave API key

1) Create a Brave Search API account at https://brave.com/search/api/
2) In the dashboard, choose the **Data for Search** plan (not “Data for AI”) and generate an API key.
3) Run `clawdbot configure --section web` to store the key in config (recommended), or set `BRAVE_API_KEY` in your environment.

Brave provides a free tier plus paid plans; check the Brave API portal for the
current limits and pricing.

### Where to set the key (recommended)

**Recommended:** run `clawdbot configure --section web`. It stores the key in
`~/.clawdbot/clawdbot.json` under `tools.web.search.apiKey`.

**Environment alternative:** set `BRAVE_API_KEY` in the Gateway process
environment. For a daemon install, put it in `~/.clawdbot/.env` (or your
service environment). See [Env vars](/start/faq#how-does-clawdbot-load-environment-variables).

## web_search

Search the web with Brave’s API.

### Requirements

- `tools.web.search.enabled` must not be `false` (default: enabled)
- Brave API key (recommended: `clawdbot configure --section web`, or set `BRAVE_API_KEY`)

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
        cacheTtlMinutes: 15
      }
    }
  }
}
```

### Tool parameters

- `query` (required)
- `count` (1–10; default from config)
- `country` (optional): 2-letter country code for region-specific results (e.g., "DE", "US", "ALL"). If omitted, Brave chooses its default region.
- `search_lang` (optional): ISO language code for search results (e.g., "de", "en", "fr")
- `ui_lang` (optional): ISO language code for UI elements

**Examples:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de"
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr"
});
```

## web_fetch

Fetch a URL and extract readable content.

### Requirements

- `tools.web.fetch.enabled` must not be `false` (default: enabled)
- Optional Firecrawl fallback: set `tools.web.fetch.firecrawl.apiKey` or `FIRECRAWL_API_KEY`.

### Config

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60
        }
      }
    }
  }
}
```

### Tool parameters

- `url` (required, http/https only)
- `extractMode` (`markdown` | `text`)
- `maxChars` (truncate long pages)

Notes:
- `web_fetch` uses Readability (main-content extraction) first, then Firecrawl (if configured). If both fail, the tool returns an error.
- Firecrawl requests use bot-circumvention mode and cache results by default.
- `web_fetch` sends a Chrome-like User-Agent and `Accept-Language` by default; override `userAgent` if needed.
- `web_fetch` is best-effort extraction; some sites will need the browser tool.
- See [Firecrawl](/tools/firecrawl) for key setup and service details.
- Responses are cached (default 15 minutes) to reduce repeated fetches.
- If you use tool profiles/allowlists, add `web_search`/`web_fetch` or `group:web`.
- If the Brave key is missing, `web_search` returns a short setup hint with a docs link.
