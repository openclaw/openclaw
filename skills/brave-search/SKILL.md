---
name: brave-search
description: Web search and content extraction via Brave Search API.
metadata: {"clawdis":{"requires":{"bins":["node","npm"],"env":["BRAVE_API_KEY"]},"primaryEnv":"BRAVE_API_KEY","install":[{"id":"node-brew","kind":"brew","formula":"node","bins":["node","npm"],"label":"Install Node.js (brew)"}]}}
---

# Brave Search

Headless web search and content extraction using Brave Search. No browser required.

## Setup (run once)

```bash
cd ~/Projects/agent-scripts/skills/brave-search
npm ci
```

Needs env: `BRAVE_API_KEY`.

## Search

```bash
./search.js "query"                    # Basic search (5 results)
./search.js "query" -n 10              # More results
./search.js "query" --content          # Include page content as markdown
./search.js "query" -n 3 --content     # Combined
```

## Extract Page Content

```bash
./content.js https://example.com/article
```

Fetches a URL and extracts readable content as markdown.
