---
summary: "Keenable web search with rich snippets and date filters"
read_when:
  - You want to use Keenable for web_search
  - You need a KEENABLE_API_KEY
title: "Keenable search"
---

[Keenable](https://keenable.ai/) is a `web_search` provider optimized for AI agents.
It returns titles, URLs, and long snippets, with optional site and date filters and
`pro` or `realtime` search modes.

## Install plugin

```bash
openclaw plugins install @openclaw/keenable-plugin
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Get an API key

<Steps>
  <Step title="Create an account">
    Sign up at [keenable.ai](https://keenable.ai/) and create an API key from your
    dashboard.
  </Step>
  <Step title="Store the key">
    Set `KEENABLE_API_KEY` in the Gateway environment, or configure via:

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

## Config

```json5
{
  plugins: {
    entries: {
      keenable: {
        config: {
          webSearch: {
            apiKey: "keen_...", // optional if KEENABLE_API_KEY is set
            baseUrl: "https://api.keenable.ai", // optional; OpenClaw appends /v1/search
            appTitle: "OpenClaw", // required X-Keenable-Title header value
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "keenable",
      },
    },
  },
}
```

**Environment alternative:** set `KEENABLE_API_KEY` in the Gateway environment. For
a gateway install, put it in `~/.openclaw/.env`. See
[Env vars](/help/faq#env-vars-and-env-loading).

Keenable requires an application identifier on every request. OpenClaw sends
`X-Keenable-Title` using `webSearch.appTitle`, defaulting to `OpenClaw`.

## Base URL override

Set `plugins.entries.keenable.config.webSearch.baseUrl` to route search requests
through a compatible proxy or alternate endpoint. OpenClaw normalizes bare hosts by
prepending `https://` and appends `/v1/search` unless the path already ends there.
The resolved endpoint is part of the search cache key.

## Tool parameters

<ParamField path="query" type="string" required>
Natural-language search query.
</ParamField>

<ParamField path="count" type="number" default="5">
Results to return (1-50).
</ParamField>

<ParamField path="mode" type="'pro' | 'realtime'" default="pro">
`pro` for higher-quality results; `realtime` for lowest latency.
</ParamField>

<ParamField path="site" type="string">
Restrict results to one site (for example `docs.openclaw.ai`).
</ParamField>

<ParamField path="published_after" type="string">
Results published after this date (`YYYY-MM-DD`).
</ParamField>

<ParamField path="published_before" type="string">
Results published before this date (`YYYY-MM-DD`).
</ParamField>

<ParamField path="acquired_after" type="string">
Results indexed after this date (`YYYY-MM-DD`).
</ParamField>

<ParamField path="acquired_before" type="string">
Results indexed before this date (`YYYY-MM-DD`).
</ParamField>

<ParamField path="query_time" type="string">
Upper time bound for point-in-time search (ISO 8601 datetime, `YYYY-MM-DD`, Unix
epoch, or offset such as `7d`). Not a recency filter; use `published_after` for
recent results.
</ParamField>

<ParamField path="snippet_max_length" type="number">
Maximum snippet length in characters (180-10000).
</ParamField>

## Related

- [Web search overview](/tools/web)
- [Keenable API docs](https://docs.keenable.ai/)
