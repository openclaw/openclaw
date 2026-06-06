---
summary: "Parallel Search -- LLM-optimized dense excerpts from web sources"
read_when:
  - You want free web search with no API key
  - You want the Parallel v1 REST Search API
  - You want dense excerpts ranked for LLM context efficiency
title: "Parallel search"
---

OpenClaw bundles two [Parallel](https://parallel.ai/) `web_search` providers:

- **Parallel Search (Free)** (`parallel-free`) -- the free hosted
  [Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) at
  `https://search.parallel.ai/mcp`. Keyless and anonymous, so `web_search` works
  with zero setup. This is OpenClaw's **zero-config default**: when no other web
  search provider is configured, OpenClaw selects it automatically, so everyone
  gets free web search out of the box. Its tool call is labeled **Parallel Web
  Search** in the UI.
- **Parallel Search** (`parallel`) -- the Parallel **v1 REST** Search API
  (`/v1/search`). Requires `PARALLEL_API_KEY`; objective-tuned with higher rate
  limits.

Both return ranked, LLM-optimized dense excerpts from a web index purpose-built
for AI agents. Use the free MCP for zero-setup search, or the REST API when you
have a key. Select one explicitly with `tools.web.search.provider:
"parallel-free"` or `"parallel"`.

<Note>
  Exception: OpenAI Responses models use OpenAI's **native** web search while
  `tools.web.search.provider` is left unset, so they do not route through the
  Parallel providers. Set `tools.web.search.provider: "parallel-free"` (or
  `"parallel"`) to route those models through Parallel.
</Note>

## Get an API key (paid `parallel` provider)

The free `parallel-free` provider needs no setup. To use the paid v1 REST API:

<Steps>
  <Step title="Create an account">
    Sign up at [platform.parallel.ai](https://platform.parallel.ai) and
    generate an API key from your dashboard.
  </Step>
  <Step title="Store the key">
    Set `PARALLEL_API_KEY` in the Gateway environment, or configure via:

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
      parallel: {
        config: {
          webSearch: {
            apiKey: "par-...", // optional if PARALLEL_API_KEY is set
            baseUrl: "https://api.parallel.ai", // optional; OpenClaw appends /v1/search
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "parallel",
      },
    },
  },
}
```

**Environment alternative:** set `PARALLEL_API_KEY` in the Gateway environment.
For a gateway install, put it in `~/.openclaw/.env`.

## Base URL override

The base URL override applies to the paid `parallel` (REST) provider only; the
free `parallel-free` provider always uses `https://search.parallel.ai/mcp`.

Set `plugins.entries.parallel.config.webSearch.baseUrl` when Parallel requests
should go through a compatible proxy or alternate Parallel endpoint (for
example, the Cloudflare AI Gateway). OpenClaw normalizes bare hosts by
prepending `https://` and appends `/v1/search` unless the path already ends
there. The resolved endpoint is included in the search cache key, so results
from different Parallel endpoints are not shared.

## Tool parameters

OpenClaw exposes Parallel's native search shape so the model can fill in both
the natural-language goal and a few short keyword queries — the pairing
Parallel [recommends](https://docs.parallel.ai/search/best-practices) for
best results.

<ParamField path="objective" type="string" required>
Natural-language description of the underlying question or goal (max 5000
chars). Should be self-contained.
</ParamField>

<ParamField path="search_queries" type="string[]" required>
Concise keyword search queries, 3-6 words each (1-5 entries, max 200 chars
each). Provide 2-3 diverse queries for best results.
</ParamField>

<ParamField path="count" type="number">
Results to return (1-40).
</ParamField>

<ParamField path="session_id" type="string">
Optional Parallel session id (max 1000 chars). Pass the `sessionId` from a
previous Parallel result on follow-up searches that are part of the same task
so Parallel can group related calls and improve subsequent results.
</ParamField>

<ParamField path="client_model" type="string">
Optional identifier of the model making the call (e.g. `claude-opus-4-7`,
`gpt-5.5`). Lets Parallel tailor default settings for your model's
capabilities. Pass the exact active model slug; do not shorten to a family
alias.
</ParamField>

## Notes

- Parallel ranks and compresses results based on LLM reasoning utility, not
  human click-through; expect dense excerpts in each result rather than
  full-page content
- Result excerpts come back as the `excerpts` array and are also joined into
  the `description` field for compatibility with the generic `web_search`
  contract
- Parallel returns a `session_id` on every response; OpenClaw surfaces it as
  `sessionId` in the tool payload so callers can group follow-up searches
- `searchId`, `warnings`, and `usage` from Parallel are passed through when
  present
- OpenClaw always forwards a resolved result count to Parallel as
  `advanced_settings.max_results`. The caller's `count` arg wins, then the
  top-level `tools.web.search.maxResults` setting, otherwise OpenClaw's
  generic `web_search` default (5). This keeps result volume consistent
  when switching between providers; Parallel on its own defaults to 10
- Results are cached for 15 minutes by default (configurable via
  `cacheTtlMinutes`)
- The free `parallel-free` provider uses the same `objective` + `search_queries`
  shape; `count` is applied client-side, a `session_id` is minted per call when
  one is not supplied, and the result carries a `searchTransport` marker that
  drives the **Parallel Web Search** tool label. The keyed REST path is unbranded.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Exa search](/tools/exa-search) -- neural search with content extraction
- [Perplexity Search](/tools/perplexity-search) -- structured results with domain filtering
