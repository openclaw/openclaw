---
name: hanzo-crawl
description: "Crawl and scrape web pages via the Hanzo Crawl API. Extract structured content from URLs, preview pages before indexing, and index crawled content into a Hanzo Search store. Use when a bot needs to scrape a webpage, crawl a site, extract content from URLs, or index web content for search."
metadata:
  { "bot": { "requires": { "bins": ["python3"] }, "primaryEnv": "HANZO_API_KEY", "emoji": "🕷" } }
---

# Hanzo Crawl -- Web Scraping & Indexing API

Crawl web pages, extract structured content, preview before indexing, and push crawled content into a Hanzo Search store.

## API Endpoints

Base URL: `https://api.cloud.hanzo.ai`

| Endpoint                   | Method | Purpose                         |
| -------------------------- | ------ | ------------------------------- |
| `/api/scrape-docs`         | POST   | Crawl and index a URL           |
| `/api/scrape-docs/preview` | POST   | Preview a page without indexing |

## Authentication

All requests require a Bearer token in the `Authorization` header. Use the bot's IAM token or a Hanzo API key.

```
Authorization: Bearer <token>
```

## Crawl and Index a URL

```bash
python3 {baseDir}/scripts/crawl.py --url "https://docs.example.com" --store my-docs
```

### Request Body (`/api/scrape-docs`)

```json
{
  "url": "https://docs.example.com/getting-started",
  "store": "my-docs",
  "depth": 1,
  "max_pages": 50,
  "selectors": {
    "content": "main, article, .content",
    "title": "h1, title",
    "exclude": "nav, footer, .sidebar"
  },
  "metadata": {
    "category": "documentation",
    "source": "example.com"
  }
}
```

### Fields

- `url` (required): Starting URL to crawl
- `store` (required): Search store to index documents into
- `depth` (optional): Crawl depth for following links (default 0 = single page, max 3)
- `max_pages` (optional): Maximum pages to crawl (default 1, max 500)
- `selectors` (optional): CSS selectors for content extraction
  - `content`: Selectors for main content (default: auto-detect)
  - `title`: Selectors for page title
  - `exclude`: Selectors for elements to exclude
- `metadata` (optional): Additional metadata to attach to indexed documents
- `wait_for` (optional): CSS selector to wait for before extraction (for JS-rendered pages)
- `headers` (optional): Custom HTTP headers for the crawl request

### Response

```json
{
  "job_id": "crawl-abc123",
  "status": "completed",
  "pages_crawled": 12,
  "documents_indexed": 10,
  "errors": [{ "url": "https://docs.example.com/broken", "error": "404 Not Found" }],
  "pages": [
    {
      "url": "https://docs.example.com/getting-started",
      "title": "Getting Started",
      "content_length": 4523,
      "indexed": true
    }
  ]
}
```

## Preview a Page

Preview extracted content without indexing. Useful for testing selectors and verifying extraction quality.

```bash
python3 {baseDir}/scripts/preview.py --url "https://docs.example.com/page"
```

### Request Body (`/api/scrape-docs/preview`)

```json
{
  "url": "https://docs.example.com/getting-started",
  "selectors": {
    "content": "main",
    "title": "h1",
    "exclude": "nav, footer"
  }
}
```

### Response

```json
{
  "url": "https://docs.example.com/getting-started",
  "title": "Getting Started",
  "content": "Full extracted text content of the page...",
  "content_length": 4523,
  "links": [
    { "href": "/next-steps", "text": "Next Steps" },
    { "href": "/api-reference", "text": "API Reference" }
  ],
  "metadata": {
    "description": "Learn how to get started",
    "language": "en"
  }
}
```

## Scripts

### `scripts/crawl.py`

Crawl a URL and index into a search store.

```bash
python3 {baseDir}/scripts/crawl.py \
  --url "https://docs.example.com" \
  --store "my-docs" \
  --depth 1 \
  --max-pages 50 \
  --token "$HANZO_API_KEY"
```

### `scripts/preview.py`

Preview page content without indexing.

```bash
python3 {baseDir}/scripts/preview.py \
  --url "https://docs.example.com/page" \
  --content-selector "main, article" \
  --exclude-selector "nav, footer" \
  --token "$HANZO_API_KEY"
```

## Billing

Crawl operations are billed per page crawled. Preview operations are billed at a reduced rate. Usage is tracked automatically through the bot gateway.

## Environment Variables

```bash
HANZO_API_KEY=...                                  # API key or IAM token
HANZO_CRAWL_BASE_URL=https://api.cloud.hanzo.ai    # Override API base URL
```
