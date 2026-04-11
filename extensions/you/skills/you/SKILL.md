---
name: you
description: You.com web search, deep research, and content extraction tools.
metadata:
  { "openclaw": { "emoji": "🔎", "requires": { "config": ["plugins.entries.you.enabled"] } } }
assets:
  - search.input.schema.json
  - search.output.schema.json
  - research.input.schema.json
  - research.output.schema.json
  - contents.input.schema.json
  - contents.output.schema.json
---

# You.com Tools

You.com provides three complementary tools for web search and research.
`web_search` works without an API key (free tier, rate-limited). `web_research` and `web_contents` require `YDC_API_KEY`.

JSON schemas for all API parameters and responses are in the [assets](assets/) directory.

## When to use which tool

| Need                               | Tool           |
| ---------------------------------- | -------------- |
| Quick web search                   | `web_search`   |
| Search with freshness/filters      | `web_search`   |
| Deep research with citations       | `web_research` |
| Extract content from specific URLs | `web_contents` |

## web_search

**Base URL:** `https://ydc-index.io`
**Endpoint:** `GET /v1/search`

Returns raw web and news results. The plugin tool exposes the most common
parameters directly; the full API surface is documented below for advanced use
or direct HTTP calls.

### Tool parameters

| Parameter    | Description                                                                |
| ------------ | -------------------------------------------------------------------------- |
| `query`      | Search query; supports operators (`site:`, `filetype:`, `+`, `-`, boolean) |
| `count`      | Results per section (1-100, default: 10)                                   |
| `freshness`  | `day`, `week`, `month`, `year`, or `YYYY-MM-DDtoYYYY-MM-DD`                |
| `country`    | Two-letter country code (e.g. `US`, `GB`, `DE`)                            |
| `safesearch` | `off`, `moderate`, or `strict`                                             |

### Additional API parameters (direct HTTP only)

These are supported by the You.com Search API but not exposed in the tool schema.
Use direct HTTP calls when you need them.

| Parameter           | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `offset`            | Pagination (0-9), calculated in multiples of `count`   |
| `language`          | BCP 47 language code (default: `EN`)                   |
| `livecrawl`         | `web`, `news`, or `all` -- enables full content inline |
| `livecrawl_formats` | `html` or `markdown` (requires `livecrawl`)            |
| `crawl_timeout`     | Timeout in seconds for livecrawl (1-60, default: 10)   |

See [search.input.schema.json](assets/search.input.schema.json) and
[search.output.schema.json](assets/search.output.schema.json) for the full
request/response schemas.

### Search operators

The `query` parameter supports operators:

- `site:domain.com` -- restrict to a domain
- `filetype:pdf` -- filter by file type
- `+term` / `-term` -- include/exclude terms
- `AND` / `OR` / `NOT` -- boolean logic

## web_research

**Base URL:** `https://api.you.com`
**Endpoint:** `POST /v1/research`

Use when you need synthesized, cited answers to complex questions. The API
autonomously runs multiple searches, reads pages, cross-references sources,
and reasons over the results. One call replaces an entire RAG pipeline.

| Parameter         | Description                                           |
| ----------------- | ----------------------------------------------------- |
| `input`           | Research question (max 40,000 chars)                  |
| `research_effort` | `lite`, `standard` (default), `deep`, or `exhaustive` |

### Research effort levels

| Level        | Latency | Best for                                      |
| ------------ | ------- | --------------------------------------------- |
| `lite`       | <2s     | Simple factual questions, low-latency apps    |
| `standard`   | 10-30s  | General-purpose questions (default)           |
| `deep`       | <120s   | Multi-faceted questions, competitive analysis |
| `exhaustive` | <300s   | High-stakes research, regulatory compliance   |

The response includes:

- `content`: Markdown with inline citation numbers `[1]`, `[2]`, etc.
- `sources`: Array of URLs and titles matching citation numbers

See [research.input.schema.json](assets/research.input.schema.json) and
[research.output.schema.json](assets/research.output.schema.json) for the full
request/response schemas.

## web_contents

**Base URL:** `https://ydc-index.io`
**Endpoint:** `POST /v1/contents`

Use when you have specific URLs and need their full content. Handles
JavaScript-rendered pages.

| Parameter       | Description                                          |
| --------------- | ---------------------------------------------------- |
| `urls`          | Array of URLs (1-20 per request)                     |
| `formats`       | `html`, `markdown`, `metadata` (default: `markdown`) |
| `crawl_timeout` | Timeout per URL in seconds (1-60, default: 10)       |

See [contents.input.schema.json](assets/contents.input.schema.json) and
[contents.output.schema.json](assets/contents.output.schema.json) for the full
request/response schemas.

## Choosing the right workflow

### Path A: Quick answers

1. **`web_search`** -- Get search results, snippets, and URLs

### Path B: Deep research

1. **`web_research`** -- One call for synthesized, cited answers
   - Best for complex questions that need thorough investigation
   - Returns Markdown with inline citations traceable to sources

### Path C: Custom pipelines

1. **`web_search`** -- Find relevant URLs
2. **`web_contents`** -- Extract full page content from those URLs
   - Use when you need raw content for custom processing
   - Use when you need to deep-read specific pages

## Tips

- **Use `web_search`** for most queries
- **Use `web_research` for complex questions** -- saves multiple tool calls
- **Use `web_contents` sparingly** -- only when you need full page content
- Results are cached automatically for efficiency
