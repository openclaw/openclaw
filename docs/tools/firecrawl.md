---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Firecrawl fallback for web_fetch (anti-bot + cached extraction)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want Firecrawl-backed web extraction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need a Firecrawl API key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want anti-bot extraction for web_fetch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Firecrawl"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Firecrawl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can use **Firecrawl** as a fallback extractor for `web_fetch`. It is a hosted（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
content extraction service that supports bot circumvention and caching, which helps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
with JS-heavy sites or pages that block plain HTTP fetches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Get an API key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a Firecrawl account and generate an API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Store it in config or set `FIRECRAWL_API_KEY` in the gateway environment.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configure Firecrawl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    web: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      fetch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        firecrawl: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          apiKey: "FIRECRAWL_API_KEY_HERE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          baseUrl: "https://api.firecrawl.dev",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          onlyMainContent: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          maxAgeMs: 172800000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          timeoutSeconds: 60,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `firecrawl.enabled` defaults to true when an API key is present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxAgeMs` controls how old cached results can be (ms). Default is 2 days.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Stealth / bot circumvention（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Firecrawl exposes a **proxy mode** parameter for bot circumvention (`basic`, `stealth`, or `auto`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw always uses `proxy: "auto"` plus `storeInCache: true` for Firecrawl requests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If proxy is omitted, Firecrawl defaults to `auto`. `auto` retries with stealth proxies if a basic attempt fails, which may use more credits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
than basic-only scraping.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How `web_fetch` uses Firecrawl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`web_fetch` extraction order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Readability (local)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Firecrawl (if configured)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Basic HTML cleanup (last fallback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Web tools](/tools/web) for the full web tool setup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
