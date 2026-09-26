---
summary: "Perplexity Search API and Sonar/OpenRouter compatibility for web_search"
read_when:
  - You want to use Perplexity Search for web search
  - You need PERPLEXITY_API_KEY or OPENROUTER_API_KEY setup
title: "Perplexity search"
---

OpenClaw supports the Perplexity Search API as a `web_search` provider. It returns structured results with `title`, `url`, and `snippet` fields.

For compatibility, OpenClaw also supports synthesized-answer setups through
direct Perplexity Sonar or OpenRouter. If you use `OPENROUTER_API_KEY`, an
`sk-or-...` key in `plugins.entries.perplexity.config.webSearch.apiKey`, or set
`plugins.entries.perplexity.config.webSearch.baseUrl` / `.model`, the provider
uses a synchronous chat-completions request and returns one AI-synthesized
answer with citations instead of structured Search API rows.

## Install plugin

Install the official plugin:

```bash
openclaw plugins install @openclaw/perplexity-plugin
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Getting a Perplexity API key

1. Create a Perplexity account at [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api).
2. Generate an API key in the dashboard.
3. Store the key in config or set `PERPLEXITY_API_KEY` in the Gateway environment.

## Sonar and OpenRouter compatibility

Existing direct Perplexity and OpenRouter configurations remain supported by
OpenClaw. Credential precedence is a configured `webSearch.apiKey`, then
`PERPLEXITY_API_KEY`, then `OPENROUTER_API_KEY`. An explicit `baseUrl` or
`model` selects the compatibility path regardless of key type.

OpenClaw's direct path calls synchronous
`POST https://api.perplexity.ai/chat/completions`; it does not use
`/v1/async/sonar`. Separately, Perplexity's API owner confirmed on September 24
that non-async Sonar selections continue after September 27 through automatic
server-side routing to an Agent API preset. Only the separate async Sonar
endpoints fully discontinue on that date. This is owner-confirmed future rollout
policy, not behavior stated in the current public migration pages or observable
in OpenClaw's current transport. Agent API itself uses `POST /v1/agent`, with
`POST /v1/responses` as its OpenAI Responses alias. Automatic routing does not
promise identical parameters, results, latency, pricing, or features.

OpenRouter is a third-party transport. That direct Perplexity continuity does
not guarantee future OpenRouter availability or behavior; check
[OpenRouter's Perplexity catalog](https://openrouter.ai/perplexity) for its
current model lifecycle.

Optional compatibility controls:

- `plugins.entries.perplexity.config.webSearch.baseUrl`
- `plugins.entries.perplexity.config.webSearch.model`

## Config examples

### Native Perplexity Search API

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "pplx-...",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "perplexity",
      },
    },
  },
}
```

### OpenRouter / Sonar compatibility

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "<openrouter-api-key>",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "perplexity/sonar-pro",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "perplexity",
      },
    },
  },
}
```

## Where to set the key

**Via config:** run `openclaw configure --section web`. It stores the key in `~/.openclaw/openclaw.json` under `plugins.entries.perplexity.config.webSearch.apiKey`. That field also accepts SecretRef objects.

**Via environment:** set `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY` in the Gateway process environment. For a gateway install, put it in `~/.openclaw/.env` (or your service environment). See [Env vars](/help/faq#env-vars-and-env-loading).

If `provider: "perplexity"` is configured and the Perplexity key SecretRef is unresolved with no env fallback, startup/reload fails fast.

## Tool parameters

These parameters apply to the native Perplexity Search API path.

<ParamField path="query" type="string" required>
Search query.
</ParamField>

<ParamField path="count" type="number" default="5">
Number of results to return (1-10). Compatibility transports accept this field
but still return one synthesized answer, not an N-result list.
</ParamField>

<ParamField path="country" type="string">
2-letter ISO country code (e.g. `US`, `DE`).
</ParamField>

<ParamField path="language" type="string">
ISO 639-1 language code (e.g. `en`, `de`, `fr`).
</ParamField>

<ParamField path="freshness" type="'day' | 'week' | 'month' | 'year'">
Time filter - `day` is 24 hours.
</ParamField>

<ParamField path="date_after" type="string">
Only results published after this date (`YYYY-MM-DD`).
</ParamField>

<ParamField path="date_before" type="string">
Only results published before this date (`YYYY-MM-DD`).
</ParamField>

<ParamField path="domain_filter" type="string[]">
Domain allowlist/denylist array (max 20).
</ParamField>

<ParamField path="max_tokens" type="number" default="25000">
Total content budget (max 1000000).
</ParamField>

<ParamField path="max_tokens_per_page" type="number" default="2048">
Per-page token limit.
</ParamField>

For the Sonar/OpenRouter compatibility path:

- `query`, `count`, and `freshness` are accepted.
- `count` is compatibility-only there; the response is still one synthesized answer with citations rather than an N-result list.
- The generated tool schema omits Search API-only filters (`country`, `language`, `date_after`, `date_before`, `domain_filter`, `max_tokens`, `max_tokens_per_page`). A caller that bypasses the schema and supplies one directly receives an explicit unsupported-option error.

**Examples:**

```javascript
// Country and language-specific search
await web_search({
  query: "renewable energy",
  country: "DE",
  language: "de",
});

// Recent results (past week)
await web_search({
  query: "AI news",
  freshness: "week",
});

// Date range search
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});

// Domain filtering (allowlist)
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", ".edu"],
});

// Domain filtering (denylist - prefix with -)
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});

// More content extraction
await web_search({
  query: "detailed AI research",
  max_tokens: 50000,
  max_tokens_per_page: 4096,
});
```

### Domain filter rules

- Maximum 20 domains per filter.
- Cannot mix allowlist and denylist entries in the same request.
- Use a `-` prefix for denylist entries (e.g., `["-reddit.com"]`).

## Notes

- Perplexity Search API returns structured web search results (`title`, `url`, `snippet`).
- Direct Perplexity overrides and OpenRouter currently use synchronous chat completions for compatibility.
- Sonar/OpenRouter compatibility returns one synthesized answer with citations, not structured result rows. Automatic direct routing does not imply response parity.
- Results are cached for 15 minutes by default (configurable via `cacheTtlMinutes`).

## Related

<CardGroup cols={2}>
  <Card title="Web search overview" href="/tools/web" icon="globe">
    All providers and auto-detection rules.
  </Card>
  <Card title="Brave search" href="/tools/brave-search" icon="shield">
    Structured results with country and language filters.
  </Card>
  <Card title="Exa search" href="/tools/exa-search" icon="magnifying-glass">
    Neural search with content extraction.
  </Card>
  <Card title="Perplexity provider" href="/providers/perplexity-provider" icon="server">
    Provider setup, auth, and config keys for Perplexity web search.
  </Card>
  <Card title="Perplexity Search API docs" href="https://docs.perplexity.ai/docs/search/quickstart" icon="arrow-up-right-from-square">
    Official Perplexity Search API quickstart and reference.
  </Card>
</CardGroup>
