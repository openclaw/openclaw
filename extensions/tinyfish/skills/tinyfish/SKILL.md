---
name: tinyfish
description: TinyFish web search and content fetch tools.
metadata:
  {
    "openclaw": { "emoji": "fish", "requires": { "config": ["plugins.entries.tinyfish.enabled"] } },
  }
---

# TinyFish Tools

## When to use which tool

| Need                 | Tool         | When                                                                |
| -------------------- | ------------ | ------------------------------------------------------------------- |
| Quick web search     | `web_search` | TinyFish selected as search provider                                |
| Fetch page content   | `web_fetch`  | TinyFish selected as fetch provider for JS-heavy or protected sites |
| Direct local browser | `browser`    | Need CDP control, persistent sessions, or local-only access         |

## web_search (via TinyFish)

TinyFish powers this automatically when selected as the search provider.

| Parameter | Description              |
| --------- | ------------------------ |
| `query`   | Search query string      |
| `count`   | Number of results (1-10) |

## web_fetch (via TinyFish)

TinyFish powers this automatically when selected as the fetch provider.
Handles JS-rendered pages and returns clean text or markdown.
