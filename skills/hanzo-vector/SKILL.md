---
name: hanzo-vector
description: "Direct vector similarity search via Hanzo Vector (Qdrant). Store embeddings with metadata, search by similarity, manage collections, and build RAG pipelines. Use when a bot needs to store or query vector embeddings, perform semantic similarity search, or manage vector collections."
metadata:
  { "bot": { "requires": { "bins": ["python3"] }, "primaryEnv": "HANZO_API_KEY", "emoji": "🧮" } }
---

# Hanzo Vector -- Similarity Search Engine

Direct vector operations on Hanzo's managed Qdrant instance. Store embeddings, search by similarity, manage collections, and build RAG pipelines.

## Endpoint

Qdrant REST API at `https://vector.hanzo.ai` (standard HTTPS port 443 via K8s ingress, or internal at `vector.hanzo.svc:6333`).

## Authentication

Pass the API key as the `api-key` header or via the Qdrant client's `api_key` parameter.

```
api-key: <token>
```

## Collections

### Create a Collection

```bash
python3 {baseDir}/scripts/vector.py collection create \
  --name documents \
  --dimension 384 \
  --distance cosine
```

### List Collections

```bash
python3 {baseDir}/scripts/vector.py collection list
```

### Delete a Collection

```bash
python3 {baseDir}/scripts/vector.py collection delete --name documents
```

### Collection Info

```bash
python3 {baseDir}/scripts/vector.py collection info --name documents
```

## Store Embeddings

### Upsert Points

```bash
python3 {baseDir}/scripts/vector.py upsert \
  --collection documents \
  --input points.json
```

Input JSON format:

```json
{
  "points": [
    {
      "id": 1,
      "vector": [0.1, 0.2, 0.3, ...],
      "payload": {
        "text": "Hello world",
        "category": "greeting",
        "source": "docs"
      }
    }
  ]
}
```

Or pipe from stdin:

```bash
echo '{"points": [...]}' | python3 {baseDir}/scripts/vector.py upsert \
  --collection documents \
  --input -
```

## Search by Similarity

```bash
python3 {baseDir}/scripts/vector.py search \
  --collection documents \
  --vector "[0.1, 0.2, 0.3, ...]" \
  --limit 10
```

### Search with Filters

```bash
python3 {baseDir}/scripts/vector.py search \
  --collection documents \
  --vector "[0.1, 0.2, ...]" \
  --filter '{"must": [{"key": "category", "match": {"value": "tech"}}]}' \
  --limit 10
```

### Filter Syntax

Qdrant filter conditions:

```json
{
  "must": [
    { "key": "category", "match": { "value": "tech" } },
    { "key": "year", "range": { "gte": 2024 } }
  ],
  "should": [{ "key": "author", "match": { "value": "hanzo" } }],
  "must_not": [{ "key": "status", "match": { "value": "draft" } }]
}
```

## Scripts Reference

### `scripts/vector.py`

Unified CLI for all vector operations.

#### Collection Management

```bash
# Create collection
python3 {baseDir}/scripts/vector.py collection create \
  --name <name> --dimension <dim> --distance <cosine|euclid|dot>

# List collections
python3 {baseDir}/scripts/vector.py collection list

# Get collection info
python3 {baseDir}/scripts/vector.py collection info --name <name>

# Delete collection
python3 {baseDir}/scripts/vector.py collection delete --name <name>
```

#### Point Operations

```bash
# Upsert points from JSON file or stdin
python3 {baseDir}/scripts/vector.py upsert \
  --collection <name> --input <file.json or ->

# Search by vector
python3 {baseDir}/scripts/vector.py search \
  --collection <name> --vector "<json array>" --limit 10

# Search with filter
python3 {baseDir}/scripts/vector.py search \
  --collection <name> --vector "<json array>" \
  --filter '<json filter>' --limit 10

# Get points by ID
python3 {baseDir}/scripts/vector.py get \
  --collection <name> --ids "1,2,3"

# Delete points by ID
python3 {baseDir}/scripts/vector.py delete \
  --collection <name> --ids "1,2,3"

# Count points
python3 {baseDir}/scripts/vector.py count --collection <name>
```

### Common Options

All commands accept:

```
--host       Qdrant host (default: $HANZO_VECTOR_HOST or https://vector.hanzo.ai)
--port       Qdrant port (only for non-standard ports; HTTPS uses standard 443)
--api-key    API key (default: $HANZO_API_KEY)
--format     Output: text, json (default: text)
```

## RAG Pipeline Example

Generate embeddings with the Hanzo API, store in vector DB, and search:

```python
from hanzoai import Hanzo

# 1. Generate embedding
ai = Hanzo(api_key="...")
embedding = ai.embeddings.create(
    model="text-embedding-3-small",
    input="What is Hanzo MCP?"
).data[0].embedding

# 2. Search vector DB
# python3 {baseDir}/scripts/vector.py search \
#   --collection knowledge --vector "<embedding>" --limit 5
```

## Billing

Vector operations are billed per query (search) and per batch (upsert). Collection management operations are free. Usage is tracked automatically through the bot gateway.

## Environment Variables

```bash
HANZO_API_KEY=...                             # API key for authentication
HANZO_VECTOR_HOST=https://vector.hanzo.ai     # Qdrant host (standard HTTPS, no port needed)
HANZO_VECTOR_PORT=                            # Only set for non-standard ports (e.g. 6333 for direct access)
```
