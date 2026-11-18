---
summary: "Kimi web search via Moonshot web search"
read_when:
  - You want to use Kimi for web_search
  - You need a KIMI_API_KEY or MOONSHOT_API_KEY
title: "Kimi search"
---

Kimi is a `web_search` provider backed by Moonshot's `POST /tools/search`
endpoint. It returns a structured list of results with titles, URLs,
descriptions, and source metadata. No chat model is used to synthesize an answer.

## Setup

The `moonshot` plugin does not ship with OpenClaw; install it first.

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/moonshot-provider
    ```

    Installation applies to a running Gateway automatically; otherwise it takes effect
    on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

  </Step>
  <Step title="Create a key">
    Get an API key from [Moonshot AI](https://platform.moonshot.cn/).
  </Step>
  <Step title="Store the key">
    Set `KIMI_API_KEY` or `MOONSHOT_API_KEY` in the Gateway environment (for a
    gateway install, add it to `~/.openclaw/.env`), or configure via:

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

Choosing **Kimi** during `openclaw onboard` or `openclaw configure --section web`
also prompts for the Moonshot API region: `https://api.moonshot.ai/v1` or
`https://api.moonshot.cn/v1`.

## Config

```json5
{
  plugins: {
    entries: {
      moonshot: {
        config: {
          webSearch: {
            apiKey: "sk-...", // optional if KIMI_API_KEY or MOONSHOT_API_KEY is set
            baseUrl: "https://api.moonshot.ai/v1",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "kimi",
      },
    },
  },
}
```

`tools.web.search.provider` is auto-detected from available API keys when omitted;
set it to `kimi` explicitly if multiple search credentials are configured.

Configure Kimi-specific `apiKey` and `baseUrl` values under
`plugins.entries.moonshot.config.webSearch`.

The `baseUrl` defaults to `https://api.moonshot.ai/v1` when omitted.

`plugins.entries.moonshot.config.webSearch.model` is deprecated and ignored.
Existing configurations containing it remain valid; you can remove the key
manually. Doctor does not remove it automatically. The older
`tools.web.search.kimi` block is already legacy config: `openclaw doctor --fix`
moves it into the plugin config, where its `model` key is likewise ignored.

If chat traffic uses the China host (`models.providers.moonshot.baseUrl`:
`https://api.moonshot.cn/v1`), Kimi `web_search` reuses that host automatically
when its own `baseUrl` is unset, so `.cn` keys do not accidentally hit the
international endpoint (which returns HTTP 401 for those keys). Set an explicit
Kimi `baseUrl` to override this inheritance.

<a id="grounding-requirement" />

## Search results

OpenClaw sends `{ "text_query": "your query", "limit": 5 }` to
`<baseUrl>/tools/search`. The requested `count` becomes `limit`. Results expose
`title`, `url`, `description` (from the search snippet), `siteName`, and
`published` when available. Titles and descriptions are wrapped as untrusted
web content. An empty result list is a successful search with `count: 0`.

This replaces Moonshot's chat-completions search builtin, which retires on
October 20, 2026. Search billing follows Moonshot's
[web-search pricing](https://platform.kimi.ai/docs/pricing/websearch), rather
than the selected chat model.

## Tool parameters

| Parameter                                                       | Supported                            |
| --------------------------------------------------------------- | ------------------------------------ |
| `query`                                                         | Yes                                  |
| `count`                                                         | Number of results (1–10, default: 5) |
| `country`, `language`, `freshness`, `date_after`, `date_before` | No                                   |

When `count` is omitted, `tools.web.search.maxResults` applies. If neither is
set, Kimi returns up to five results.

## Related

- [Web Search overview](/tools/web) - all providers and auto-detection
- [Moonshot AI](/providers/moonshot) - Moonshot model + Kimi Coding provider docs
- [Gemini Search](/tools/gemini-search) - AI-synthesized answers via Google grounding
- [Grok Search](/tools/grok-search) - AI-synthesized answers via xAI grounding
