# SerpApi Search Provider Plugin

Search the web using [SerpApi](https://serpapi.com/) with **vertical search routing** — automatically route queries to Google News, Scholar, Images, Shopping, Maps, and more.

## Features

- **20+ search verticals** via a single `engine` parameter
- **Zero extra LLM calls** — the model picks the vertical as part of its normal tool call
- **Google + alternative engines** (Bing, Baidu, Yandex, Naver, DuckDuckGo)
- **Structured results** with titles, URLs, descriptions, ratings, prices, citations
- **Freshness filtering** for Google engines (past day/week/month/year)

## Supported Engines

| Engine            | Alias        | What it searches   |
| ----------------- | ------------ | ------------------ |
| `google`          | (default)    | Regular web search |
| `google_news`     | `news`       | News articles      |
| `google_scholar`  | `scholar`    | Academic papers    |
| `google_images`   | `images`     | Image search       |
| `google_shopping` | `shopping`   | Products & prices  |
| `google_maps`     | `maps`       | Local places & POI |
| `google_jobs`     | `jobs`       | Job listings       |
| `google_finance`  | `finance`    | Financial data     |
| `google_patents`  | `patents`    | Patent search      |
| `youtube`         | `youtube`    | YouTube videos     |
| `bing`            | `bing`       | Bing web search    |
| `baidu`           | `baidu`      | Baidu (Chinese)    |
| `yandex`          | `yandex`     | Yandex (Russian)   |
| `naver`           | `naver`      | Naver (Korean)     |
| `duckduckgo`      | `duckduckgo` | DuckDuckGo         |

## Installation

1. Copy this directory to your OpenClaw extensions folder
2. Add to your config:

```json
{
  "plugins": {
    "load": {
      "paths": ["./extensions/serpapi-search"]
    },
    "entries": {
      "serpapi-search": {
        "enabled": true,
        "config": {
          "apiKey": "your-serpapi-api-key"
        }
      }
    }
  },
  "tools": {
    "web": {
      "search": {
        "provider": "serpapi"
      }
    }
  }
}
```

Or set the `SERPAPI_API_KEY` environment variable.

## Usage

Once installed, `web_search` calls are routed through SerpApi. The LLM can select verticals naturally:

- "Search for recent AI news" → LLM picks `engine: "news"`
- "Find papers on transformer architecture" → LLM picks `engine: "scholar"`
- "How much does iPhone 16 cost" → LLM picks `engine: "shopping"`
- "Coffee shops near Times Square" → LLM picks `engine: "maps"`
- General questions → default `engine: "google"`

## Configuration

| Option          | Env Var           | Description                                                               |
| --------------- | ----------------- | ------------------------------------------------------------------------- |
| `apiKey`        | `SERPAPI_API_KEY` | Your SerpApi API key ([get one here](https://serpapi.com/manage-api-key)) |
| `defaultEngine` | —                 | Default engine when none specified (default: `google`)                    |

## Pricing

SerpApi offers a free tier with 100 searches/month. Paid plans start at $50/month for 5,000 searches. See [serpapi.com/pricing](https://serpapi.com/pricing).
