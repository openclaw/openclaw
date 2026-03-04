---
name: brave-search
description: "智能搜索。Real-time web search via Brave Search API or Exa. Use when: (1) user asks for current info, news, or facts not in context, (2) finding URLs or recent content, (3) fact-checking or research. Prefer when recency matters; for semantic/code search consider exa or codebase tools."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔍",
        "requires": { "env": ["BRAVE_API_KEY"] },
        "primaryEnv": "BRAVE_API_KEY",
        "install":
          [
            {
              "id": "brave-api",
              "kind": "manual",
              "label": "Get Brave Search API key at https://brave.com/search/api/",
            },
          ],
      },
  }
---

# Brave Search / Smart Search (智能搜索)

Real-time web search using the Brave Search API (or Exa when configured). Use for current information, news, and finding recent pages.

## When to use

- User asks for “latest”, “current”, “recent”, or “what’s happening”
- Finding official docs, articles, or URLs by topic
- Quick fact-check or research beyond the conversation context

## Setup

1. Get an API key: https://brave.com/search/api/
2. Configure in OpenClaw:
   - Env: `BRAVE_API_KEY=your-key`
   - Or config: `skills.entries["brave-search"].apiKey` in `~/.openclaw/openclaw.json`

## Usage (bash + curl)

Brave Search API example (replace `$BRAVE_API_KEY` with your key or use env):

```bash
# GET request
curl -s -G "https://api.search.brave.com/res/v1/web/search" \
  --data-urlencode "q=YOUR_QUERY" \
  -H "Accept: application/json" \
  -H "X-Subscription-Token: $BRAVE_API_KEY"
```

For Exa (semantic search), set `EXA_API_KEY` and use Exa’s API; the agent can call search endpoints via bash when the keys are configured.

## Optional: Exa

For semantic / “find pages about X” style search, use Exa (exa.ai). Set `EXA_API_KEY` and invoke Exa API via bash or a small script. Same pattern: key in env or `skills.entries["brave-search"].env.EXA_API_KEY`.
