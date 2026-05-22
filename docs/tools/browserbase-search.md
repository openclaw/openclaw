---
summary: "Browserbase Search setup for web_search"
read_when:
  - You want to use Browserbase Search for web_search
  - You need a BROWSERBASE_API_KEY
title: "Browserbase search"
---

OpenClaw supports [Browserbase Search](https://docs.browserbase.com/platform/search/overview) as a native `web_search` provider.

Browserbase Search is a lightweight structured search API that pairs well with Browserbase browser automation when you need fast web results before deciding whether to open a live page.

## Get an API key

<Steps>
  <Step title="Create an account">
    Sign up at [browserbase.com](https://www.browserbase.com/) and generate an API key.
  </Step>
  <Step title="Store the key">
    Set `BROWSERBASE_API_KEY` in the Gateway environment, or configure via:

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

## Install

This provider ships as an external plugin and can be installed directly with:

```bash
openclaw plugins install clawhub:@browserbasehq/openclaw-browserbase-search
```

After install, `openclaw configure --section web` can select Browserbase Search and store the credential.

## Config

```json5
{
  plugins: {
    entries: {
      "browserbase-search": {
        config: {
          webSearch: {
            apiKey: "bb_...", // optional if BROWSERBASE_API_KEY is set
            baseUrl: "https://api.browserbase.com/v1/search", // optional override
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "browserbase-search",
      },
    },
  },
}
```

## Base URL override

Set `plugins.entries.browserbase-search.config.webSearch.baseUrl` when Browserbase search requests should go through a compatible proxy or alternate endpoint.

If the configured value ends in:

- `/v1/search`, OpenClaw uses it directly
- `/v1`, OpenClaw appends `/search`
- anything else, OpenClaw appends `/v1/search`

## Tool parameters

<ParamField path="query" type="string" required>
Search query.
</ParamField>

<ParamField path="count" type="number" default="5">
Results to return (1-25).
</ParamField>

## Notes

- Results are returned as structured titles, URLs, and snippets.
- Optional Browserbase response fields such as `author`, `publishedDate`, `image`, and `favicon` are preserved when present.
- Results are cached for 15 minutes by default (configurable via `cacheTtlMinutes`).
- For JS-heavy pages, auth flows, or interactive scraping, use the [Web Browser](/tools/browser) instead of `web_search`.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Web Browser](/tools/browser) -- interactive browser automation
- [Browserbase Search docs](https://docs.browserbase.com/platform/search/overview)
