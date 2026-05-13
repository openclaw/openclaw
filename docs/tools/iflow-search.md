---
summary: "iFlow Search API setup for web_search, image search, and web fetch"
read_when:
  - You want to use iFlow Search (心流搜索) for web_search
  - You need IFLOW_API_KEY or Chinese-first search results
title: "iFlow search"
---

OpenClaw supports iFlow Search (心流搜索) as a `web_search` provider, plus
two extra agent tools for image search and clean web-page extraction. iFlow's
results are Chinese-first but cover the global web.

## Get an API key

1. Create an account at the [iFlow Open Platform](https://platform.iflow.cn).
2. Generate an API key in the dashboard.
3. Store the key in config or set `IFLOW_API_KEY` in the Gateway environment.

## Config example

```json5
{
  plugins: {
    entries: {
      iflow: {
        enabled: true,
        config: {
          webSearch: {
            apiKey: "IFLOW_API_KEY_HERE",
            baseUrl: "https://platform.iflow.cn", // optional override
            timeoutSeconds: 30,                   // optional, default 30
            cacheTtlMinutes: 15,                  // optional, default 15; set 0 to disable
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "iflow",
      },
    },
  },
}
```

Provider-specific iFlow settings live under
`plugins.entries.iflow.config.webSearch.*`. The plugin also reads
`IFLOW_API_KEY` from the Gateway environment as a fallback when the
config-level key is absent.

## Install

The plugin is published on npm as
[`@iflow-ai/iflow-plugin`](https://www.npmjs.com/package/@iflow-ai/iflow-plugin).
After choosing iFlow in `openclaw onboard` or `openclaw configure --section web`,
OpenClaw installs it on demand. To install manually:

```bash
openclaw plugins install @iflow-ai/iflow-plugin
openclaw gateway restart
openclaw plugins inspect iflow
```

## Tools

The plugin exposes three explicit tools alongside the managed `web_search`
provider routing. Tool names use the `iflow_` prefix for namespace clarity.

### `iflow_web_search`

<ParamField path="query" type="string" required>
Search query. Forwarded to iFlow as `keywords`.
</ParamField>

<ParamField path="count" type="number" default="10">
Number of results to return (1–10). Forwarded to iFlow as `num`.
</ParamField>

Returns `{ query, provider:"iflow", count, tookMs, results: [{ title, url, snippet, position, date }] }`.

### `iflow_image_search`

<ParamField path="query" type="string" required>
Image search query. Forwarded to iFlow as `keywords`.
</ParamField>

<ParamField path="count" type="number" default="10">
Number of images to return (1–20). Forwarded to iFlow as `num`.
</ParamField>

Returns `{ query, provider:"iflow", count, tookMs, images: [{ url, title, sourceUrl }] }`.

### `iflow_web_fetch`

<ParamField path="url" type="string" required>
HTTP(S) URL to fetch.
</ParamField>

Returns `{ title, url, content, fromCache, provider:"iflow", tookMs }`.

**Example:**

```javascript
// Web search
await web_search({ query: "Java Spring Boot 教程" });

// Image search (via the explicit tool)
await iflow_image_search({ query: "小猫", count: 5 });

// Clean-content fetch
await iflow_web_fetch({ url: "https://example.com/article" });
```

## Notes

- Results are cached in-memory for 15 minutes by default (configurable via
  `cacheTtlMinutes`; set `0` to disable). The cache key includes the iFlow
  base URL, so proxy-specific responses do not collide.
- The plugin also registers `iflow` as a `web_search` provider via
  `api.registerWebSearchProvider` when the runtime exposes that API; if the
  runtime does not, the three explicit tools above still work.
- Error codes: `missing_api_key`, `missing_param`, `invalid_param`,
  `network_timeout`, `network_error`, `api_error`, `api_business_error`.

## Attribution headers

The iFlow plugin sends non-sensitive attribution headers so iFlow can identify requests coming from the OpenClaw plugin integration. No API key, user query, URL, search keywords, or user content is added to these headers.

```http
IFlow-Source: openclaw
IFlow-Integration: @iflow-ai/iflow-plugin
IFlow-Integration-Version: <plugin version>
```

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [iFlow plugin on GitHub](https://github.com/zhengyanglsun/openclaw-iflow-plugin)
- [iFlow Open Platform](https://platform.iflow.cn/)
