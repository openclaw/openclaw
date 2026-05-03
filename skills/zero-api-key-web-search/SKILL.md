---
name: zero-api-key-web-search
description: Free web search, claim verification, and page browsing with optional Bright Data production SERP (7 engines) and Web Unlocker for blocked pages.
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["python3"], "pypi": ["zero-api-key-web-search"] },
        "install":
          [
            {
              "id": "pip",
              "kind": "pip",
              "package": "zero-api-key-web-search",
              "label": "Install zero-api-key-web-search (pip)",
            },
          ],
      },
  }
---

# Zero-API-Key Web Search

Web search, claim verification, and page browsing — free by default, production-ready with Bright Data.

## Install

```bash
pip install -U zero-api-key-web-search
```

## Search (Free)

```bash
python3 -c "from zero_api_key_web_search import UltimateSearcher; s = UltimateSearcher(); print(s.search('python 3.13'))"
```

## Search (Production — 7 Engines)

```bash
export ZERO_SEARCH_BRIGHTDATA_API_KEY=your_key
python3 -c "from zero_api_key_web_search import UltimateSearcher; s = UltimateSearcher(profile='production'); print(s.search('python 3.13'))"
```

Multi-engine: `providers=['brightdata']` with `engine='bing'`, `'duckduckgo'`, `'yandex'`, `'baidu'`, `'yahoo'`, or `'naver'`.

## Claim Verification

```bash
python3 -c "from zero_api_key_web_search import UltimateSearcher; s = UltimateSearcher(); print(s.verify_claim('Python 3.13 is the latest stable release'))"
```

## Browse Page (with Web Unlocker)

```bash
python3 -c "from zero_api_key_web_search.browse_page import browse; print(browse('https://example.com'))"
```

Auto-fallback on 403/429 via Bright Data Web Unlocker when configured.

## MCP Server

```bash
pip install zero-api-key-web-search[mcp]
zero-api-key-web-search-mcp
```

8 tools: `search_web`, `search_web_results`, `verify_claim`, `evidence_report`, `browse_page`, `setup_providers`, `list_providers`, `provider_statuses`.

## Provider Profiles

| Profile | Providers | Cost |
|---------|-----------|------|
| `free` | DDGS | Free |
| `default` | DDGS | Free |
| `free-verified` | DDGS + SearXNG | Free |
| `production` | Bright Data SERP | Paid |
| `production-unlock` | Bright Data + Web Unlocker | Paid |
| `max-evidence` | All providers | Paid |

## Bright Data Setup

1. Sign up at [https://get.brightdata.com/h21j9xz4uxgd](https://get.brightdata.com/h21j9xz4uxgd) — 5000 free credits
2. Copy API key from dashboard
3. Set `ZERO_SEARCH_BRIGHTDATA_API_KEY=your_key`
4. Run `zero-api-key-web-search-mcp` → `setup_providers`