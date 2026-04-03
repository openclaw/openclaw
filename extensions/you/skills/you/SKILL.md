---
name: you
description: You.com web search, deep research, and content extraction tools.
metadata:
  { "openclaw": { "emoji": "🔎", "requires": { "config": ["plugins.entries.you.enabled"] } } }
---

# You.com Tools

You.com provides three complementary tools for web search and research:

## When to use which tool

| Need                               | Tool           |
| ---------------------------------- | -------------- |
| Quick web search                   | `web_search`   |
| Search with freshness/filters      | `web_search`   |
| Deep research with citations       | `web_research` |
| Extract content from specific URLs | `web_contents` |

All tools require `YDC_API_KEY`.

## web_search

You.com powers this automatically when selected as the search provider. Requires
`YDC_API_KEY`.

| Parameter | Description                            |
| --------- | -------------------------------------- |
| `query`   | Search query string                    |
| `count`   | Number of results (1-100, default: 10) |

## web_research

Use when you need synthesized, cited answers to complex questions. The API
autonomously runs multiple searches, reads pages, cross-references sources,
and reasons over the results. One call replaces an entire RAG pipeline.

**Requires YDC_API_KEY.**

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

## web_contents

Use when you have specific URLs and need their full content. Handles
JavaScript-rendered pages.

**Requires YDC_API_KEY.**

| Parameter       | Description                                          |
| --------------- | ---------------------------------------------------- |
| `urls`          | Array of URLs (1-20 per request)                     |
| `formats`       | `html`, `markdown`, `metadata` (default: `markdown`) |
| `crawl_timeout` | Timeout per URL in seconds (1-60, default: 10)       |

## Choosing the right workflow

### Path A: Quick answers

1. **`web_search`** — Get search results, snippets, and URLs

### Path B: Deep research

1. **`web_research`** — One call for synthesized, cited answers
   - Best for complex questions that need thorough investigation
   - Returns Markdown with inline citations traceable to sources

### Path C: Custom pipelines

1. **`web_search`** — Find relevant URLs
2. **`web_contents`** — Extract full page content from those URLs
   - Use when you need raw content for custom processing
   - Use when you need to deep-read specific pages

## Tips

- **Use `web_search`** for most queries
- **Use `web_research` for complex questions** — saves multiple tool calls
- **Use `web_contents` sparingly** — only when you need full page content
- **Cache responses** — results are cached automatically for efficiency
