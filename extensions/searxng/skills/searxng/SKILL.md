# SearXNG Web Search

Search the web privately using SearXNG — a self-hosted, privacy-respecting meta-search engine that aggregates results from Google, Bing, DuckDuckGo and dozens of other sources simultaneously.

## Key facts

- **No API key required** — works out of the box using public SearXNG instances
- **Privacy-first** — queries are not tracked or stored
- **Aggregated results** — combines multiple search engines for better coverage
- **Bring your own instance** — configure a local or self-hosted SearXNG URL in `openclaw.json` for maximum reliability

## Usage examples

> "search the web for best restaurants in Lisbon"  
> "find recent news about AI regulation in Europe"  
> "what is the capital of Mozambique"

## Configuration (optional)

In `~/.openclaw/openclaw.json`, under `plugins.entries.searxng.config.webSearch`:

| Field | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | string | (public instances) | URL of your own SearXNG instance |
| `language` | string | `en-US` | Results language (e.g. `pt-PT`) |
| `safeSearch` | `"0"`\|`"1"`\|`"2"` | `"1"` | 0=off, 1=moderate, 2=strict |

### Run your own instance (recommended for reliability)

```bash
docker run -d -p 8080:8080 searxng/searxng
```

Then add to `openclaw.json`:

```json
"plugins": {
  "entries": {
    "searxng": {
      "config": {
        "webSearch": {
          "baseUrl": "http://localhost:8080",
          "language": "pt-PT"
        }
      }
    }
  }
}
```
