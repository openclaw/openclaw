---
summary: "Perplexity Search API, Agent API, and OpenRouter compatibility for web_search"
read_when:
  - You want to use Perplexity Search for web search
  - You need PERPLEXITY_API_KEY or OPENROUTER_API_KEY setup
title: "Perplexity search"
---

OpenClaw supports the Perplexity Search API as a `web_search` provider. It returns structured results with `title`, `url`, and `snippet` fields.

For compatibility, OpenClaw also supports synthesized Perplexity answers. Direct
Perplexity `baseUrl` / `model` overrides use the Agent API, while
`OPENROUTER_API_KEY`, an `sk-or-...` configured key, or another non-Perplexity
base URL keeps the OpenAI-compatible chat-completions path. Both return one
AI-synthesized answer with citations instead of structured Search API rows.

Legacy direct Sonar model names map to the replacement Agent API presets:

| Sonar model           | Agent API preset |
| --------------------- | ---------------- |
| `sonar`               | `fast`           |
| `sonar-pro`           | `low`            |
| `sonar-reasoning-pro` | `medium`         |
| `sonar-deep-research` | `high`           |

Other direct model overrides are sent as Agent API model IDs with web search
enabled.

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

## OpenRouter compatibility

If you were already using OpenRouter for Perplexity Sonar, keep `provider: "perplexity"` and set `OPENROUTER_API_KEY` in the Gateway environment, or store an `sk-or-...` key in `plugins.entries.perplexity.config.webSearch.apiKey`.

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

### Direct synthesized answers

Set a direct Perplexity model override to keep synthesized `web_search` answers
through Agent API instead of structured Search API rows:

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "pplx-...",
            model: "sonar-pro", // maps to Agent API preset "low"
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
Number of results to return (1-10).
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

For the synthesized Agent API/OpenRouter compatibility paths:

- `query`, `count`, and `freshness` are accepted.
- `count` is compatibility-only there; the response is still one synthesized answer with citations rather than an N-result list.
- Search API-only filters (`country`, `language`, `date_after`, `date_before`, `domain_filter`, `max_tokens`, `max_tokens_per_page`) return explicit errors.

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
- A direct Perplexity `baseUrl` / `model` override uses Agent API. OpenRouter and other non-Perplexity base URLs keep chat completions for compatibility.
- Agent API/OpenRouter compatibility returns one synthesized answer with citations, not structured result rows.
- Results are cached for 15 minutes by default (configurable via `cacheTtlMinutes`).

## Optional Agent API research tool

The plugin also owns an optional `perplexity_research` tool for cited synthesis
and deep research. It does not replace or change the `web_search` provider and
is hidden unless explicitly allowlisted:

```json5
{
  tools: { allow: ["perplexity_research"] },
}
```

The tool requires a direct Perplexity API key; OpenRouter credentials continue
to work only through the existing `web_search` compatibility path. Parameters:

- `query` (required): research question or task.
- `effort`: `low`, `medium`, `high` (default), or `xhigh`.
- `freshness`: optional `day`, `week`, `month`, or `year` recency filter.

The result includes the synthesized answer and normalized citation URLs. Choose
`xhigh` only when maximum research depth justifies the additional latency and
cost.

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
