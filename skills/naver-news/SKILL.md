---
name: naver-news
description: Search Korean news articles using Naver Search API. Use when searching for Korean news, getting latest news updates, finding news about specific topics, or preparing daily news summaries. Supports relevance and date-based sorting.
homepage: https://developers.naver.com/docs/serviceapi/search/news/news.md
metadata: {"openclaw":{"emoji":"📰","requires":{"bins":["python3"],"env":["NAVER_CLIENT_ID","NAVER_CLIENT_SECRET"]}}}
---

# Naver News Search

Search Korean news articles using the Naver Search API.

## Quick Start

Use the provided script to search news:

```bash
python scripts/search_news.py "검색어" --display 10 --sort date
```

Options:
- `--display N`: Number of results per page (1-100, default: 10)
- `--start N`: Start position for pagination (1-1000, default: 1)
- `--sort sim|date`: Sort by relevance (sim) or date (date, default: date)
- `--after DATETIME`: Only show news published after this time (ISO 8601 format, e.g., `2026-01-29T09:00:00+09:00`)
- `--min-results N`: Minimum number of results to fetch (enables auto-pagination)
- `--max-pages N`: Maximum number of pages to try when auto-paginating (default: 5)
- `--json`: Output raw JSON instead of formatted text

## Setup

### Environment Variables

Required credentials from https://developers.naver.com/:

```bash
NAVER_CLIENT_ID=your_client_id
NAVER_CLIENT_SECRET=your_client_secret
```

**Configuration locations:**
- **Sandbox (default):** Add to `agents.defaults.sandbox.docker.env` in OpenClaw config
- **Host:** Add to `env.vars` in OpenClaw config

### Getting API Credentials

1. Visit https://developers.naver.com/
2. Register an application
3. Enable "검색" (Search) API
4. Copy Client ID and Client Secret
5. Add credentials to appropriate config section (see above)

## Common Use Cases

### Latest news on a topic

```bash
python scripts/search_news.py "AI 인공지능" --display 20 --sort date
```

### Search with relevance ranking

```bash
python scripts/search_news.py "삼성전자" --sort sim
```

### Filter by time (only recent news)

```bash
# News published after 9 AM today
python scripts/search_news.py "경제" --display 50 --sort sim --after "2026-01-29T09:00:00+09:00"

# News from the last hour (programmatic use)
python scripts/search_news.py "속보" --after "$(date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M:%S%z')"
```

### Auto-pagination for guaranteed minimum results

```bash
# Fetch at least 30 results (automatically requests multiple pages if needed)
python scripts/search_news.py "AI" --sort sim --after "2026-01-29T09:00:00+09:00" --min-results 30 --display 50

# Limit to 3 pages maximum
python scripts/search_news.py "게임" --min-results 50 --max-pages 3
```

**How auto-pagination works:**
1. Fetches first page (e.g., 50 results)
2. Applies date filter (e.g., 10 results remain)
3. If below `--min-results`, automatically fetches next page
4. Stops when minimum is reached or `--max-pages` limit hit

### Pagination for more results

```bash
# First 10 results
python scripts/search_news.py "경제" --display 10 --start 1

# Next 10 results
python scripts/search_news.py "경제" --display 10 --start 11
```

## Using in Python Code

Import and use the search function directly:

```python
from scripts.search_news import search_news

result = search_news(
    query="경제 뉴스",
    display=10,
    sort="date"
)

for item in result["items"]:
    print(item["title"])
    print(item["description"])
    print(item["link"])
```

## API Details

For complete API reference including response structure, error codes, and rate limits, see:

**[references/api.md](references/api.md)**

## Notes

- Search queries must be UTF-8 encoded
- Results include `<b>` tags around search term matches (strip them for clean text)
- Daily limit: 25,000 API calls per application
- `link` field may point to Naver News or original source depending on availability
