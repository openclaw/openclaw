---
summary: "You.com search, research, and content extraction tools"
read_when:
  - You want You.com-backed web search
  - You need a You.com API key
  - You want You.com as a web_search provider
  - You want deep research with citations
  - You want content extraction from URLs
title: "You.com"
---

# You.com

OpenClaw can use **You.com** in three ways:

- as the `web_search` provider (free tier available)
- as `web_research` for deep, multi-step research with citations
- as `web_contents` for extracting content from specific URLs

You.com provides a search API with a free tier for basic usage, plus a Research API for comprehensive, cited answers and a Contents API for extracting clean content from webpages.

## Get an API key

1. Create a You.com account at [you.com](https://you.com/).
2. Generate an API key in the dashboard.
3. Store it in config or set `YDC_API_KEY` in the gateway environment.

**Note:** `web_search` with You.com works without an API key (free tier with rate limits). `web_research` and `web_contents` require an API key.

## Configure You.com search

```json5
{
  plugins: {
    entries: {
      you: {
        enabled: true,
        config: {
          webSearch: {
            apiKey: "...", // optional for web_search; required for web_research/web_contents
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "you",
      },
    },
  },
}
```

Notes:

- Choosing You.com in onboarding or `openclaw configure --section web` enables the bundled You.com plugin automatically.
- Store You.com config under `plugins.entries.you.config.webSearch.*`.
- `web_search` with You.com supports `query` and `count` (up to 100 results).
- `web_search` works without an API key (free tier with rate limits).
- `web_research` and `web_contents` require `YDC_API_KEY`.

## You.com plugin tools

### `web_research`

Use this for complex questions that need thorough investigation. The API autonomously runs multiple searches, reads pages, cross-references sources, and reasons over the results. One call replaces an entire RAG pipeline.

**Requires YDC_API_KEY.**

| Parameter         | Description                                           |
| ----------------- | ----------------------------------------------------- |
| `input`           | Research question (max 40,000 chars)                  |
| `research_effort` | `lite`, `standard` (default), `deep`, or `exhaustive` |

**Research effort levels:**

| Level        | Latency | Best for                                      |
| ------------ | ------- | --------------------------------------------- |
| `lite`       | <2s     | Simple factual questions, low-latency apps    |
| `standard`   | 10-30s  | General-purpose questions (default)           |
| `deep`       | <120s   | Multi-faceted questions, competitive analysis |
| `exhaustive` | <300s   | High-stakes research, regulatory compliance   |

The response includes:

- `content`: Markdown with inline citation numbers `[1]`, `[2]`, etc.
- `sources`: Array of URLs and titles matching citation numbers

### `web_contents`

Use this to extract clean content from specific URLs. Handles JavaScript-rendered pages and supports multiple output formats.

**Requires YDC_API_KEY.**

| Parameter       | Description                                          |
| --------------- | ---------------------------------------------------- |
| `urls`          | Array of URLs (1-20 per request)                     |
| `formats`       | `html`, `markdown`, `metadata` (default: `markdown`) |
| `crawl_timeout` | Timeout per URL in seconds (1-60, default: 10)       |

Tips:

- Max 20 URLs per request. Batch larger lists into multiple calls.
- Use `markdown` format for clean text extraction.
- Use `metadata` for page titles, descriptions, and Open Graph data.

## Choosing the right tool

| Need                               | Tool           | API Key  |
| ---------------------------------- | -------------- | -------- |
| Quick web search                   | `web_search`   | Optional |
| Deep research with citations       | `web_research` | Required |
| Extract content from specific URLs | `web_contents` | Required |

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Tavily](/tools/tavily) -- search + extraction with AI answers
- [Firecrawl](/tools/firecrawl) -- search + scraping with content extraction
