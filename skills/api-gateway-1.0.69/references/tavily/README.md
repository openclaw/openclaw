# Tavily Routing Reference

**App name:** `tavily`
**Base URL proxied:** `api.tavily.com`

## API Path Pattern

```
/tavily/{endpoint}
```

## Common Endpoints

### Search

Perform AI-powered web search.

```bash
POST /tavily/search
Content-Type: application/json

{
  "query": "latest AI news",
  "max_results": 5
}
```

With answer generation:

```bash
POST /tavily/search
Content-Type: application/json

{
  "query": "What is machine learning?",
  "max_results": 5,
  "include_answer": true,
  "search_depth": "advanced"
}
```

### Extract

Extract content from URLs.

```bash
POST /tavily/extract
Content-Type: application/json

{
  "urls": ["https://example.com/article"],
  "format": "markdown"
}
```

### Map

Discover URLs from a website.

```bash
POST /tavily/map
Content-Type: application/json

{
  "url": "https://example.com",
  "limit": 20,
  "max_depth": 2
}
```

### Crawl

Crawl a website and extract content.

```bash
POST /tavily/crawl
Content-Type: application/json

{
  "url": "https://example.com",
  "limit": 10,
  "max_depth": 2
}
```

### Research Tasks

#### Create Research Task

```bash
POST /tavily/research
Content-Type: application/json

{
  "input": "What are the latest developments in AI?",
  "model": "mini"
}
```

Models: `mini` (fast), `pro` (comprehensive), `auto` (default)

#### Get Research Task

```bash
GET /tavily/research/{request_id}
```

## Search Parameters

| Parameter       | Type           | Description                               |
| --------------- | -------------- | ----------------------------------------- |
| query           | string         | Search query (required)                   |
| max_results     | integer        | Results count (0-20, default 5)           |
| search_depth    | string         | `basic`, `advanced`, `fast`, `ultra-fast` |
| topic           | string         | `general` or `news`                       |
| include_answer  | boolean/string | Generate AI answer                        |
| include_domains | array          | Whitelist domains                         |
| exclude_domains | array          | Blacklist domains                         |
| time_range      | string         | `day`, `week`, `month`, `year`            |

## Notes

- All search/extract/crawl/map endpoints use POST method
- Research task GET uses GET method
- Authentication is automatic - the gateway injects the API key
- Search includes optional AI-generated answers
- Map returns URLs only; Crawl returns URLs with content
- Using `instructions` in crawl/map doubles credit cost
- Research tasks are async - poll GET endpoint for results

## Resources

- [Tavily API Documentation](https://docs.tavily.com)
- [Search API Reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Extract API Reference](https://docs.tavily.com/documentation/api-reference/endpoint/extract)
- [Crawl API Reference](https://docs.tavily.com/documentation/api-reference/endpoint/crawl)
- [Map API Reference](https://docs.tavily.com/documentation/api-reference/endpoint/map)
- [Research API Reference](https://docs.tavily.com/documentation/api-reference/endpoint/research)
