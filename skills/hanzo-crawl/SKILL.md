---
name: hanzo-crawl
description: "Crawl and scrape web pages via the Hanzo Crawl API (Crawl4AI). Extract structured content and markdown from URLs, preview pages, and crawl sites with JavaScript rendering support. Use when a bot needs to scrape a webpage, crawl a site, or extract content from URLs."
metadata:
  { "bot": { "requires": { "bins": ["python3"] }, "primaryEnv": "HANZO_API_KEY", "emoji": "🕷" } }
---

# Hanzo Crawl -- Web Scraping API (Crawl4AI)

Crawl web pages and extract structured markdown content via Crawl4AI. Supports JavaScript-rendered pages, CSS selectors for targeted extraction, and async crawl processing.

## API Endpoints

Base URL: `https://crawl.hanzo.ai`

| Endpoint     | Method | Purpose                              |
| ------------ | ------ | ------------------------------------ |
| `/crawl`     | POST   | Crawl a URL and extract content      |
| `/md`        | POST   | Quick markdown extraction from a URL |
| `/task/{id}` | GET    | Poll async crawl task status         |
| `/health`    | GET    | Health check                         |

## Authentication

All requests require a Bearer token in the `Authorization` header. Use the HANZO_API_KEY env var.

```
Authorization: Bearer <token>
```

## Crawl a URL

```bash
python3 {baseDir}/scripts/crawl.py --url "https://docs.example.com"
```

### Request Body (`POST /crawl`)

```json
{
  "urls": "https://docs.example.com/getting-started",
  "word_count_threshold": 10,
  "css_selector": "main, article",
  "excluded_tags": ["nav", "footer", "aside"],
  "wait_for": ".content-loaded",
  "magic": false,
  "screenshot": false
}
```

### Fields

- `urls` (required): URL string or array of URLs to crawl
- `word_count_threshold` (optional): Minimum word count for content blocks (default 10)
- `css_selector` (optional): CSS selector for targeted content extraction
- `excluded_tags` (optional): Array of HTML tags to exclude from extraction
- `wait_for` (optional): CSS selector to wait for before extraction (for JS-rendered pages)
- `js_code` (optional): Array of JavaScript code strings to execute before extraction
- `magic` (optional): Enable magic mode for complex pages (default false)
- `screenshot` (optional): Take a screenshot of the page (default false)

### Response

The `/crawl` endpoint returns a `task_id` for async processing. Poll `/task/{task_id}` until completion.

```json
{
  "task_id": "abc123-def456",
  "status": "completed",
  "result": {
    "url": "https://docs.example.com/getting-started",
    "success": true,
    "markdown": "# Getting Started\n\nTo deploy your application...",
    "links": {
      "internal": [{ "href": "/next-steps", "text": "Next Steps" }],
      "external": [{ "href": "https://github.com/...", "text": "Source" }]
    },
    "media": {
      "images": [{ "src": "...", "alt": "..." }]
    }
  }
}
```

## Preview a Page (Markdown)

Quick markdown extraction without async processing.

```bash
python3 {baseDir}/scripts/preview.py --url "https://docs.example.com/page"
```

### Request Body (`POST /md`)

```json
{
  "url": "https://docs.example.com/getting-started"
}
```

### Response

```json
{
  "url": "https://docs.example.com/getting-started",
  "success": true,
  "title": "Getting Started",
  "markdown": "# Getting Started\n\nFull extracted markdown content...",
  "status_code": 200
}
```

## Scripts

### `scripts/crawl.py`

Crawl a URL and extract content via Crawl4AI.

```bash
python3 {baseDir}/scripts/crawl.py \
  --url "https://docs.example.com" \
  --css-selector "main, article" \
  --excluded-tags "nav,footer,aside" \
  --token "$HANZO_API_KEY"
```

### `scripts/preview.py`

Quick markdown preview of a page.

```bash
python3 {baseDir}/scripts/preview.py \
  --url "https://docs.example.com/page" \
  --token "$HANZO_API_KEY"
```

## Billing

Crawl operations are billed per page crawled. Preview (markdown) operations are billed at a reduced rate. Usage is tracked automatically through the bot gateway.

## Environment Variables

```bash
HANZO_API_KEY=...                                  # API token for authentication
HANZO_CRAWL_BASE_URL=https://crawl.hanzo.ai        # Override API base URL
```
