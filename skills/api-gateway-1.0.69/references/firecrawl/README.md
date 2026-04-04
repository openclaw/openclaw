# Firecrawl Routing Reference

**App name:** `firecrawl`
**Base URL proxied:** `api.firecrawl.dev`

## API Path Pattern

```
/firecrawl/v2/{resource}
```

## Scrape Endpoints

### Scrape Webpage

```bash
POST /firecrawl/v2/scrape
```

### Batch Scrape

```bash
POST /firecrawl/v2/batch/scrape
```

### Get Batch Scrape Status

```bash
GET /firecrawl/v2/batch/scrape/{id}
```

### Cancel Batch Scrape

```bash
DELETE /firecrawl/v2/batch/scrape/{id}
```

### Get Batch Scrape Errors

```bash
GET /firecrawl/v2/batch/scrape/{id}/errors
```

## Crawl Endpoints

### Start Crawl

```bash
POST /firecrawl/v2/crawl
```

### Get Crawl Status

```bash
GET /firecrawl/v2/crawl/{id}
```

### Cancel Crawl

```bash
DELETE /firecrawl/v2/crawl/{id}
```

### Get Crawl Errors

```bash
GET /firecrawl/v2/crawl/{id}/errors
```

### Get Active Crawls

```bash
GET /firecrawl/v2/crawl/active
```

## Map Endpoints

### Map Site URLs

```bash
POST /firecrawl/v2/map
```

## Search Endpoints

### Search Web

```bash
POST /firecrawl/v2/search
```

## Extract Endpoints

### Start Extract

```bash
POST /firecrawl/v2/extract
```

### Get Extract Status

```bash
GET /firecrawl/v2/extract/{id}
```

## Browser Endpoints

### Create Browser Session

```bash
POST /firecrawl/v2/browser
```

### List Browser Sessions

```bash
GET /firecrawl/v2/browser
```

### Delete Browser Session

```bash
DELETE /firecrawl/v2/browser/{id}
```

## Agent Endpoints

### Start Agent

```bash
POST /firecrawl/v2/agent
```

### Get Agent Status

```bash
GET /firecrawl/v2/agent/{id}
```

### Cancel Agent

```bash
DELETE /firecrawl/v2/agent/{id}
```

## Common Parameters

### Scrape Options

- `url` (required): Target URL
- `urls` (required for batch): Array of URLs
- `formats`: Output formats - "markdown", "html", "json", "screenshot", "links"
- `onlyMainContent`: Extract main content only (default: true)
- `waitFor`: Milliseconds to wait before scraping
- `timeout`: Request timeout in ms
- `mobile`: Emulate mobile device
- `actions`: Browser actions array
- `blockAds`: Block ads/cookie banners

### Crawl Options

- `url` (required): Starting URL
- `limit`: Max pages to crawl
- `maxDepth`: Maximum crawl depth
- `includePaths`: URL patterns to include
- `excludePaths`: URL patterns to exclude
- `scrapeOptions`: Options for each page

### Search Options

- `query` (required): Search query (max 500 chars)
- `limit`: Number of results (default: 5, max: 100)
- `sources`: "web", "images", "news"
- `country`: ISO country code
- `tbs`: Time filter ("qdr:d", "qdr:w", "qdr:m", "qdr:y")

### Extract Options

- `urls` (required): Array of URLs
- `prompt` (required): Natural language extraction instruction
- `schema`: JSON schema for structured output

### Agent Options

- `prompt` (required): Description of what to extract (max 10,000 chars)
- `urls`: URLs to constrain the agent to
- `schema`: JSON schema for structured output
- `maxCredits`: Spending limit (default: 2500)
- `model`: "spark-1-mini" (default) or "spark-1-pro"

## Response Format

All endpoints return:

```json
{
  "success": boolean,
  "data": {...} or [...],
  "creditsUsed": number
}
```

Async jobs return job ID for polling:

```json
{
  "success": true,
  "id": "job-id",
  "url": "status-url"
}
```

## Notes

- Uses API key authentication
- 1 credit per page (basic), up to 5 credits for anti-bot sites
- Crawl/batch results expire after 24 hours
- Maximum timeout: 300,000ms

## Resources

- [Firecrawl API Documentation](https://docs.firecrawl.dev/api-reference/v2-introduction)
- [Firecrawl Dashboard](https://firecrawl.dev)
