---
name: brave-search
description: Web search and content extraction via Brave Search API.
metadata: {"clawdis":{"requires":{"bins":["node"],"env":["BRAVE_API_KEY"]},"primaryEnv":"BRAVE_API_KEY"}}
---

# Brave Search

Headless web search (and lightweight content extraction) using Brave Search API. No browser required.

## Search

```bash
node {baseDir}/scripts/search.mjs "query"
node {baseDir}/scripts/search.mjs "query" -n 10
node {baseDir}/scripts/search.mjs "query" --content
node {baseDir}/scripts/search.mjs "query" -n 3 --content
```

## Extract a page

```bash
node {baseDir}/scripts/content.mjs "https://example.com/article"
```

Notes:
- Needs `BRAVE_API_KEY`.
- Content extraction is best-effort (good for articles; not for app-like sites).
- If a site is blocked or too JS-heavy, prefer the `summarize` skill (it can use a Firecrawl fallback).
