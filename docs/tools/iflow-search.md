---
summary: "iFlow Search API setup for web_search, image search, and web fetch"
read_when:
  - You want to use iFlow Search (心流搜索) for web_search
  - You need IFLOW_API_KEY or Chinese-first search results
  - You want image search via iflow_image_search
title: "iFlow search"
---

OpenClaw supports [iFlow Search (心流搜索)](https://platform.iflow.cn) as a `web_search` provider, plus
three explicit agent tools for web search, image search, and clean web-page extraction.
iFlow's results are Chinese-first but cover the global web.

| Property      | Value                               |
| ------------- | ----------------------------------- |
| Plugin id     | `iflow`                             |
| Auth          | `IFLOW_API_KEY` or config `apiKey`  |
| Base URL      | `https://platform.iflow.cn` (default) |
| Bundled tools | `iflow_web_search`, `iflow_image_search`, `iflow_web_fetch` |

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an account at the [iFlow Open Platform](https://platform.iflow.cn)
    and generate an API key in the dashboard.
  </Step>
  <Step title="Configure the plugin and provider">
    ```json5
    {
      plugins: {
        entries: {
          iflow: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: "your-key-here", // optional if IFLOW_API_KEY is set
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
        // Enable iFlow explicit tools alongside the coding profile
        alsoAllow: [
          "iflow_web_search",
          "iflow_image_search",
          "iflow_web_fetch"
        ],
      },
    }
    ```
  </Step>
  <Step title="Verify search runs">
    Trigger a `web_search` from any agent, or call `iflow_web_search` directly.
  </Step>
</Steps>

<Tip>
Choosing iFlow in onboarding or `openclaw configure --section web` enables the
bundled iFlow plugin automatically.
</Tip>

## Install

The plugin is published on npm as
[`@iflow-ai/iflow-plugin`](https://www.npmjs.com/package/@iflow-ai/iflow-plugin).
After choosing iFlow in `openclaw onboard` or `openclaw configure --section web`,
OpenClaw installs it on demand. To install manually:

```bash
openclaw plugins install @iflow-ai/iflow-plugin@0.1.6
openclaw gateway restart
openclaw plugins inspect iflow --runtime --json
```

## Provider vs explicit tools

The iFlow plugin exposes two capability layers:

### Web Search Provider

When configured as `tools.web.search.provider = "iflow"`, iFlow powers the
built-in **`web_search`** tool. This tool is always visible in the `coding`
profile — no extra configuration needed.

### Explicit Tools

The plugin also registers three explicit tools with additional capabilities:

| Tool | Purpose | Why use it |
|------|---------|-----------|
| `iflow_web_search` | Web search with iFlow-specific controls | Direct access, independent of provider routing |
| `iflow_image_search` | **Image search** — not available via `web_search` | The only way to search images through iFlow |
| `iflow_web_fetch` | Fetch web page content | Direct access, independent of provider routing |

<Note>
`iflow_image_search` is **not** the OpenClaw built-in `image` tool (which is for
image understanding/vision). It is a dedicated image search tool that returns
image URLs, titles, and source pages.
</Note>

### Tool visibility and profiles

OpenClaw's `tools.profile` controls which tools are available to the agent:

| Profile | `web_search` (provider) | Explicit tools (`iflow_*`) |
|---------|------------------------|---------------------------|
| `coding` (default) | ✅ Always visible | ❌ Hidden by default |
| `full` | ✅ Always visible | ✅ Visible |
| `coding` + `alsoAllow` | ✅ Always visible | ✅ Visible |

To enable explicit tools with the `coding` profile, add `alsoAllow`:

```json5
{
  tools: {
    profile: "coding",
    alsoAllow: [
      "iflow_web_search",
      "iflow_image_search",
      "iflow_web_fetch"
    ],
  },
}
```

<Note>
This is standard OpenClaw behavior — all plugin explicit tools (including
Tavily's `tavily_search` and `tavily_extract`) follow the same profile rules.
</Note>

## Tool reference

### `iflow_web_search`

Search the public web via iFlow Search. Returns titles, URLs, snippets,
position, and (when available) publish date. Chinese-language results are
first-class.

<ParamField path="query" type="string" required>
Search query. Forwarded to iFlow as `keywords`.
</ParamField>

<ParamField path="count" type="number" default="10">
Number of results to return (1–10). Forwarded to iFlow as `num`.
</ParamField>

Returns `{ query, provider:"iflow", count, tookMs, results: [{ title, url, snippet, position, date }] }`.

### `iflow_image_search`

Search the public web for images via iFlow Search. Returns image URLs, titles,
and source page URLs.

<ParamField path="query" type="string" required>
Image search query. Forwarded to iFlow as `keywords`.
</ParamField>

<ParamField path="count" type="number" default="10">
Number of images to return (1–20). Forwarded to iFlow as `num`.
</ParamField>

Returns `{ query, provider:"iflow", count, tookMs, images: [{ url, title, sourceUrl }] }`.

### `iflow_web_fetch`

Fetch the readable content of a single web page via iFlow Search. Returns
title, plain-text/markdown content, and a cache hint.

<ParamField path="url" type="string" required>
HTTP(S) URL to fetch.
</ParamField>

Returns `{ title, url, content, fromCache, provider:"iflow", tookMs }`.

## Choosing the right tool

| Need                                     | Tool                |
| ---------------------------------------- | ------------------- |
| Quick web search, no special options     | `web_search`        |
| iFlow-specific search with count control | `iflow_web_search`  |
| Image search                             | `iflow_image_search`|
| Extract content from a specific URL      | `iflow_web_fetch`   |

<Note>
The generic `web_search` tool with iFlow as provider supports `query` and
`count` (up to 10 results). For image search or web content extraction, use the
explicit tools.
</Note>

## Advanced configuration

<AccordionGroup>
  <Accordion title="API key resolution order">
    The iFlow client looks up its API key in this order:

    1. `plugins.entries.iflow.config.webSearch.apiKey` (resolved through SecretRefs).
    2. `IFLOW_API_KEY` from the gateway environment.

    All tools raise a setup error if neither is present.

  </Accordion>

  <Accordion title="Custom base URL">
    Override `plugins.entries.iflow.config.webSearch.baseUrl` if you front iFlow
    through a proxy. The default is `https://platform.iflow.cn`.
  </Accordion>

  <Accordion title="Cache">
    Results are cached in-memory for 15 minutes by default (configurable via
    `cacheTtlMinutes`; set `0` to disable). The cache key includes the iFlow
    base URL, so proxy-specific responses do not collide.
  </Accordion>
</AccordionGroup>

| Option                    | Default                      | Description                                  |
| ------------------------- | ---------------------------- | -------------------------------------------- |
| `webSearch.apiKey`        | `IFLOW_API_KEY` env var      | API key (string or SecretRef).               |
| `webSearch.baseUrl`       | `https://platform.iflow.cn`  | API endpoint override.                       |
| `webSearch.timeoutSeconds`| `30`                         | HTTP timeout per request in seconds.         |
| `webSearch.cacheTtlMinutes`| `15`                        | In-memory cache TTL in minutes. Set 0 to disable. |

## Error codes

| Code | Meaning |
|------|---------|
| `missing_api_key` | No API key found in config or environment. |
| `missing_param` | A required parameter was not provided. |
| `invalid_param` | A parameter value is invalid (e.g., non-HTTP URL). |
| `network_timeout` | Request to iFlow timed out. |
| `network_error` | Network failure talking to iFlow. |
| `api_error` | iFlow returned a non-2xx HTTP status. |
| `api_business_error` | iFlow returned `success: false`. |

## Attribution headers

The iFlow plugin sends non-sensitive attribution headers so iFlow can identify
requests coming from the OpenClaw plugin integration. No API key, user query,
URL, search keywords, or user content is added to these headers.

```http
IFlow-Source: openclaw
IFlow-Integration: @iflow-ai/iflow-plugin
IFlow-Integration-Version: <plugin version>
```

## Related

<CardGroup cols={2}>
  <Card title="Web Search overview" href="/tools/web" icon="magnifying-glass">
    All providers and auto-detection rules.
  </Card>
  <Card title="Tavily" href="/tools/tavily" icon="globe">
    Tavily search and extract tools.
  </Card>
  <Card title="Brave Search" href="/tools/brave-search" icon="shield">
    Brave Search with snippets and filters.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config schema for plugin entries and tool routing.
  </Card>
</CardGroup>
