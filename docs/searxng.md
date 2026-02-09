---
summary: "SearXNG setup for web_search (self-hosted, no API key)"
read_when:
  - You want to use SearXNG for web search
  - You need to set up a self-hosted SearXNG instance
title: "SearXNG"
---

# SearXNG

OpenClaw can use [SearXNG](https://github.com/searxng/searxng) as a self-hosted
provider for the `web_search` tool. SearXNG is a metasearch engine that
aggregates results from multiple search engines (Google, Bing, DuckDuckGo, etc.).
No API key is required -- just a running instance.

## Setup with Docker

Create a directory and configuration for SearXNG:

```bash
mkdir -p ~/searxng/searxng
```

Create `~/searxng/searxng/settings.yml` to enable the JSON API:

```yaml
use_default_settings: true

search:
  formats:
    - html
    - json

server:
  # Generate a real secret: openssl rand -hex 32
  secret_key: "replace-with-a-random-secret"
  limiter: false # Enable rate limiting in production
```

Create `~/searxng/docker-compose.yml`:

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    container_name: searxng
    ports:
      - "8888:8080"
    volumes:
      - ./searxng:/etc/searxng:rw
    environment:
      - SEARXNG_BASE_URL=http://localhost:8888/
    restart: unless-stopped
```

Start the instance:

```bash
cd ~/searxng && docker compose up -d
```

Verify it responds:

```bash
curl -s "http://localhost:8888/search?q=test&format=json" | head -c 200
```

## Config example

```json5
{
  tools: {
    web: {
      search: {
        provider: "searxng",
        searxng: {
          baseUrl: "http://localhost:8888",
        },
      },
    },
  },
}
```

**Environment alternative:** set `SEARXNG_BASE_URL` in the Gateway environment
instead of config. For a gateway install, put it in `~/.openclaw/.env`.

## Troubleshooting

**"SearXNG API error (403)"** -- The JSON format is not enabled. Add `json` to
`search.formats` in `settings.yml` and restart the container.

**"SearXNG API error (429)"** -- Rate limited. Set `limiter: false` in
`settings.yml` for local use, or adjust rate limits for production.

**Connection refused** -- Verify the container is running (`docker ps`) and the
port mapping matches your `baseUrl`.

See [Web tools](/tools/web) for the full web_search configuration.
