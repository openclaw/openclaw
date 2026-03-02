---
name: hanzo-search
description: "Search indexed documentation and knowledge bases via Hanzo Search (Meilisearch). Supports fulltext search with faceted filtering and ranking. Use when a bot needs to search docs, knowledge bases, or indexed content, or when a user asks to find information across indexed sources."
metadata:
  { "bot": { "requires": { "bins": ["python3"] }, "primaryEnv": "HANZO_API_KEY", "emoji": "🔍" } }
---

# Hanzo Search -- Meilisearch Document Search API

Search indexed documentation and knowledge bases with fulltext retrieval and faceted filtering, powered by Meilisearch.

## API Endpoints

Base URL: `https://search.hanzo.ai`

| Endpoint                     | Method | Purpose                      |
| ---------------------------- | ------ | ---------------------------- |
| `/indexes/{index}/search`    | POST   | Search documents in an index |
| `/indexes`                   | GET    | List all indexes             |
| `/indexes/{index}`           | GET    | Get index details            |
| `/indexes/{index}/documents` | GET    | Browse documents in an index |

## Authentication

All requests require a Bearer token in the `Authorization` header. Use the MEILI_MASTER_KEY via the HANZO_API_KEY env var.

```
Authorization: Bearer <token>
```

## Search Documents

```bash
python3 {baseDir}/scripts/search.py --query "how to deploy" --store my-docs
```

### Request Body (`/indexes/{index}/search`)

```json
{
  "q": "how to deploy to kubernetes",
  "limit": 10,
  "offset": 0,
  "filter": "category = 'deployment'"
}
```

### Fields

- `q` (required): Search query string
- `limit` (optional): Max results (default 10, max 100)
- `offset` (optional): Pagination offset (default 0)
- `filter` (optional): Meilisearch filter expression (e.g. `"category = 'deployment'"`)
- `sort` (optional): Array of sort rules (e.g. `["updated_at:desc"]`)
- `attributesToRetrieve` (optional): Array of attributes to return
- `attributesToHighlight` (optional): Array of attributes to highlight

### Response

```json
{
  "hits": [
    {
      "id": "doc-123",
      "title": "Kubernetes Deployment Guide",
      "url": "https://docs.example.com/deploy",
      "content": "To deploy your application to Kubernetes...",
      "category": "deployment",
      "updated_at": "2026-01-15"
    }
  ],
  "query": "how to deploy to kubernetes",
  "processingTimeMs": 12,
  "estimatedTotalHits": 42,
  "limit": 10,
  "offset": 0
}
```

## RAG Chat over Search Results

RAG chat requires the Hanzo Cloud API layer on top of Meilisearch. The `chat.py` script calls the `/api/chat-docs` endpoint which retrieves documents via Meilisearch and generates an LLM-grounded response.

```bash
python3 {baseDir}/scripts/chat.py --query "explain the deployment process" --store my-docs
```

### Request Body (`/api/chat-docs`)

```json
{
  "query": "explain the deployment process step by step",
  "store": "my-docs",
  "mode": "hybrid",
  "limit": 5,
  "stream": true
}
```

### Fields

- `query` (required): Chat question
- `store` (required): Search store to ground answers in
- `mode` (optional): Search mode for retrieval (`"hybrid"`, `"fulltext"`, `"vector"`)
- `limit` (optional): Number of source documents to retrieve (default 5)
- `stream` (optional): Stream response chunks (default true)
- `model` (optional): LLM model for chat generation
- `system_prompt` (optional): Override system prompt for the chat

### Streaming Response

Each line is a JSON chunk:

```json
{"type": "source", "data": {"id": "doc-123", "title": "...", "url": "...", "score": 0.95}}
{"type": "chunk", "data": {"text": "The deployment process"}}
{"type": "chunk", "data": {"text": " involves three steps..."}}
{"type": "done", "data": {"sources_count": 5, "tokens_used": 342}}
```

## Scripts

### `scripts/search.py`

Search documents from the command line via Meilisearch.

```bash
python3 {baseDir}/scripts/search.py \
  --query "search terms" \
  --store "index-name" \
  --limit 10 \
  --token "$HANZO_API_KEY"
```

### `scripts/chat.py`

RAG chat over search results (requires Hanzo Cloud API layer).

```bash
python3 {baseDir}/scripts/chat.py \
  --query "your question" \
  --store "store-name" \
  --limit 5 \
  --token "$HANZO_API_KEY"
```

## Billing

Each search query is billed per the Hanzo Search pricing tier. RAG chat queries include both the search cost and the LLM generation cost. Usage is tracked automatically through the bot gateway.

## Environment Variables

```bash
HANZO_API_KEY=...                                  # Meilisearch master key
HANZO_SEARCH_BASE_URL=https://search.hanzo.ai      # Override search API base URL
HANZO_CHAT_BASE_URL=https://search.hanzo.ai        # Override RAG chat API base URL
```
