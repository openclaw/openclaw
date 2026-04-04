# Exa Routing Reference

**App name:** `exa`
**Base URL proxied:** `api.exa.ai`

## API Path Pattern

```
/exa/{endpoint}
```

## Common Endpoints

### Search

Perform neural web search with optional content extraction.

```bash
POST /exa/search
Content-Type: application/json

{
  "query": "latest AI research papers",
  "numResults": 10
}
```

With content extraction:

```bash
POST /exa/search
Content-Type: application/json

{
  "query": "machine learning tutorials",
  "numResults": 5,
  "contents": {
    "text": true,
    "highlights": true
  }
}
```

With filters:

```bash
POST /exa/search
Content-Type: application/json

{
  "query": "startup funding news",
  "numResults": 10,
  "category": "news",
  "startPublishedDate": "2024-01-01T00:00:00.000Z",
  "includeDomains": ["techcrunch.com", "venturebeat.com"]
}
```

### Get Contents

Retrieve full page contents for specific URLs.

```bash
POST /exa/contents
Content-Type: application/json

{
  "ids": ["https://example.com/article1", "https://example.com/article2"],
  "text": true
}
```

With highlights and summary:

```bash
POST /exa/contents
Content-Type: application/json

{
  "ids": ["https://example.com/article"],
  "text": true,
  "highlights": true,
  "summary": true
}
```

### Find Similar

Find pages similar to a given URL.

```bash
POST /exa/findSimilar
Content-Type: application/json

{
  "url": "https://anthropic.com",
  "numResults": 10
}
```

With domain filters:

```bash
POST /exa/findSimilar
Content-Type: application/json

{
  "url": "https://openai.com",
  "numResults": 5,
  "excludeDomains": ["openai.com"]
}
```

### Answer

Get AI-generated answers with citations.

```bash
POST /exa/answer
Content-Type: application/json

{
  "query": "What is machine learning?",
  "text": true
}
```

### Research Tasks

Run async research tasks that explore the web and synthesize findings.

#### Create Research Task

```bash
POST /exa/research/v1
Content-Type: application/json

{
  "instructions": "What are the top AI companies and their products?",
  "model": "exa-research"
}
```

Models: `exa-research-fast`, `exa-research` (default), `exa-research-pro`

#### Get Research Task

```bash
GET /exa/research/v1/{researchId}
```

Optional query params: `events=true`, `stream=true`

#### List Research Tasks

```bash
GET /exa/research/v1?limit=10
```

Pagination with `cursor` and `limit` (1-50).

## Search Parameters

| Parameter          | Type    | Description                                                                                 |
| ------------------ | ------- | ------------------------------------------------------------------------------------------- |
| query              | string  | Search query (required)                                                                     |
| numResults         | integer | Max results (1-100, default 10)                                                             |
| type               | string  | `neural`, `auto`, `keyword`                                                                 |
| category           | string  | `company`, `research paper`, `news`, `tweet`, `personal site`, `financial report`, `people` |
| includeDomains     | array   | Whitelist domains                                                                           |
| excludeDomains     | array   | Blacklist domains                                                                           |
| startPublishedDate | string  | ISO 8601 date (after)                                                                       |
| endPublishedDate   | string  | ISO 8601 date (before)                                                                      |

## Content Options

| Option     | Type    | Description          |
| ---------- | ------- | -------------------- |
| text       | boolean | Full page text       |
| highlights | boolean | Relevant snippets    |
| summary    | boolean | AI-generated summary |

## Notes

- Search/contents/answer endpoints use POST method
- Research task list/get use GET method
- Authentication is automatic - the gateway injects the API key
- Search types: `neural` (semantic), `auto` (hybrid), `keyword` (traditional)
- Maximum 100 results per request
- Content extraction (text, highlights, summary) incurs additional costs
- Categories `people` and `company` have restricted filter support
- Timestamps are in ISO 8601 format
- Costs are returned in `costDollars` field

## Resources

- [Exa API Documentation](https://exa.ai/docs)
- [Search API Reference](https://exa.ai/docs/reference/search)
- [Contents API Reference](https://exa.ai/docs/reference/contents)
- [Find Similar API Reference](https://exa.ai/docs/reference/findsimilar)
- [Answer API Reference](https://exa.ai/docs/reference/answer)
- [Research API Reference](https://exa.ai/docs/reference/research/create-a-task)
- [LLM Reference](https://exa.ai/docs/llms.txt)
