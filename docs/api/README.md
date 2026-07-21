# Mythos API Documentation

Complete API reference for Mythos-class OpenClaw with Rust-powered multi-agent AI.

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Core APIs](#core-apis)
  - [Vector Search API](#vector-search-api)
  - [Text Search API](#text-search-api)
  - [Embedding API](#embedding-api)
  - [Agent API](#agent-api)
  - [Task API](#task-api)
- [WebSocket API](#websocket-api)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [Examples](#examples)

---

## Overview

Mythos exposes a RESTful API for interacting with the multi-agent AI system. All endpoints are prefixed with `/api/v1/`.

**Base URL:**
```
http://localhost:18789/api/v1
```

**Authentication:**
All requests require a Bearer token in the Authorization header.

---

## Authentication

### Bearer Token

Include your gateway token in the Authorization header:

```bash
curl -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
     http://localhost:18789/api/v1/health
```

### Token Generation

Generate a secure token:

```bash
openssl rand -hex 32
```

---

## Core APIs

### Vector Search API

Perform semantic similarity search using HNSW index.

#### Store Vector

```http
POST /api/v1/vector/store
Content-Type: application/json

{
  "vector": [0.1, 0.2, ..., 0.1536],
  "metadata": {
    "source": "document_123",
    "timestamp": 1705847293000,
    "category": "fact"
  }
}
```

**Response:**
```json
{
  "success": true,
  "id": "vec_abc123"
}
```

#### Search Vectors

```http
POST /api/v1/vector/search
Content-Type: application/json

{
  "query": [0.1, 0.2, ..., 0.1536],
  "top_k": 10,
  "min_similarity": 0.7,
  "filters": {
    "category": "fact"
  }
}
```

**Response:**
```json
{
  "results": [
    {
      "id": "vec_abc123",
      "similarity": 0.95,
      "metadata": {
        "source": "document_123",
        "category": "fact"
      }
    }
  ],
  "count": 1
}
```

#### Batch Store

```http
POST /api/v1/vector/batch-store
Content-Type: application/json

{
  "vectors": [
    [0.1, 0.2, ...],
    [0.3, 0.4, ...]
  ],
  "metadata": [
    {"source": "doc_1"},
    {"source": "doc_2"}
  ]
}
```

#### Get Statistics

```http
GET /api/v1/vector/stats
```

**Response:**
```json
{
  "count": 1000000,
  "dimensions": 1536,
  "index_size_mb": 4096,
  "avg_query_time_ms": 1.5
}
```

---

### Text Search API

Full-text search with BM25 ranking using Tantivy.

#### Index Document

```http
POST /api/v1/search/index
Content-Type: application/json

{
  "documents": [
    {
      "id": "doc_1",
      "content": "Rust is a systems programming language",
      "metadata": {
        "author": "Alice",
        "tags": ["programming", "rust"]
      }
    }
  ]
}
```

#### Search Documents

```http
POST /api/v1/search/query
Content-Type: application/json

{
  "query": "Rust programming",
  "top_k": 10,
  "filters": {
    "tags": ["programming"]
  },
  "highlight": true
}
```

**Response:**
```json
{
  "results": [
    {
      "id": "doc_1",
      "score": 2.5,
      "content": "Rust is a systems programming language",
      "metadata": {
        "author": "Alice",
        "tags": ["programming", "rust"]
      },
      "highlights": [
        "<em>Rust</em> is a systems <em>programming</em> language"
      ]
    }
  ],
  "count": 1
}
```

#### Advanced Queries

**Phrase Query:**
```json
{
  "query": "\"systems programming\"",
  "type": "phrase"
}
```

**Boolean Query:**
```json
{
  "query": "Rust AND (programming OR language)",
  "type": "boolean"
}
```

**Fuzzy Query:**
```json
{
  "query": "programing~2",
  "type": "fuzzy"
}
```

---

### Embedding API

Generate vector embeddings for text using Candle (GPU-accelerated).

#### Single Embedding

```http
POST /api/v1/embedding/embed
Content-Type: application/json

{
  "text": "This is a test sentence",
  "model": "all-MiniLM-L6-v2"
}
```

**Response:**
```json
{
  "embedding": [0.1, 0.2, ..., 0.1536],
  "dimensions": 1536,
  "model": "all-MiniLM-L6-v2"
}
```

#### Batch Embeddings

```http
POST /api/v1/embedding/batch
Content-Type: application/json

{
  "texts": [
    "First sentence",
    "Second sentence",
    "Third sentence"
  ],
  "model": "all-MiniLM-L6-v2"
}
```

**Response:**
```json
{
  "embeddings": [
    [0.1, 0.2, ...],
    [0.3, 0.4, ...],
    [0.5, 0.6, ...]
  ],
  "count": 3
}
```

#### List Available Models

```http
GET /api/v1/embedding/models
```

**Response:**
```json
{
  "models": [
    {
      "name": "all-MiniLM-L6-v2",
      "dimensions": 384,
      "device": "cpu"
    },
    {
      "name": "all-mpnet-base-v2",
      "dimensions": 768,
      "device": "cuda"
    }
  ]
}
```

---

### Agent API

Manage and communicate with AI agents.

#### List Agents

```http
GET /api/v1/agents
```

**Response:**
```json
{
  "agents": [
    {
      "id": "agent_1",
      "name": "Research Agent",
      "status": "idle",
      "capabilities": ["search", "analyze"],
      "metadata": {
        "version": "1.0",
        "model": "claude-opus-4-7"
      }
    }
  ]
}
```

#### Register Agent

```http
POST /api/v1/agents/register
Content-Type: application/json

{
  "id": "agent_new",
  "name": "New Agent",
  "capabilities": ["execute", "analyze"],
  "metadata": {
    "version": "1.0",
    "model": "claude-sonnet-4-6"
  }
}
```

#### Send Message

```http
POST /api/v1/agents/message
Content-Type: application/json

{
  "from": "agent_1",
  "to": "agent_2",
  "type": "request",
  "payload": {
    "action": "analyze",
    "data": {
      "query": "Find information about Rust"
    }
  }
}
```

#### Get Agent Inbox

```http
GET /api/v1/agents/:id/inbox?limit=10
```

---

### Task API

Manage tasks and workflows.

#### Create Task

```http
POST /api/v1/tasks
Content-Type: application/json

{
  "title": "Analyze dataset",
  "description": "Perform statistical analysis on the dataset",
  "assigned_to": ["agent_1", "agent_2"],
  "dependencies": [],
  "priority": "high",
  "metadata": {
    "deadline": "2026-01-25",
    "estimated_hours": 4
  }
}
```

**Response:**
```json
{
  "id": "task_abc123",
  "status": "pending",
  "created_at": "2026-01-20T14:30:00Z"
}
```

#### Update Task Status

```http
PATCH /api/v1/tasks/:id
Content-Type: application/json

{
  "status": "in_progress",
  "assigned_to": ["agent_1"],
  "result": {
    "progress": 50,
    "notes": "Data preprocessing complete"
  }
}
```

#### Get Task

```http
GET /api/v1/tasks/:id
```

#### List Tasks

```http
GET /api/v1/tasks?status=pending&assigned_to=agent_1
```

#### Get Ready Tasks

```http
GET /api/v1/tasks/ready
```

Returns tasks with all dependencies completed.

---

## WebSocket API

Real-time communication with agents.

### Connection

```javascript
const ws = new WebSocket('ws://localhost:18789/ws');

ws.onopen = () => {
  console.log('Connected');
};
```

### Message Format

```json
{
  "type": "message",
  "from": "client",
  "to": "agent_1",
  "payload": {
    "action": "analyze",
    "data": "..."
  },
  "timestamp": 1705847293000,
  "id": "msg_abc123"
}
```

### Subscribe to Agent Events

```json
{
  "type": "subscribe",
  "agent_id": "agent_1",
  "events": ["status", "message", "task"]
}
```

---

## Error Handling

All API errors follow this format:

```json
{
  "error": {
    "code": "VECTOR_DIMENSION_MISMATCH",
    "message": "Expected 1536 dimensions, got 1000",
    "status": 400,
    "details": {
      "expected": 1536,
      "received": 1000
    }
  }
}
```

### Common Error Codes

| Code | Status | Description |
|------|--------|-------------|
| `VECTOR_DIMENSION_MISMATCH` | 400 | Vector dimensions don't match index |
| `AGENT_NOT_FOUND` | 404 | Agent ID doesn't exist |
| `TASK_DEPENDENCY_FAILED` | 400 | Task dependencies not met |
| `SANDBOX_TIMEOUT` | 408 | Sandbox execution timed out |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server error |

---

## Rate Limiting

API requests are rate-limited:

- **Standard tier:** 100 requests/minute
- **Premium tier:** 1000 requests/minute
- **Enterprise tier:** Custom limits

Rate limit headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705847353
```

---

## Examples

### Complete Workflow Example

```javascript
// 1. Embed text
const embedding = await fetch('/api/v1/embedding/embed', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TOKEN'
  },
  body: JSON.stringify({
    text: 'Rust is a systems programming language'
  })
}).then(r => r.json());

// 2. Store in vector index
await fetch('/api/v1/vector/store', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TOKEN'
  },
  body: JSON.stringify({
    vector: embedding.embedding,
    metadata: { text: 'Rust is a systems programming language' }
  })
});

// 3. Index in text search
await fetch('/api/v1/search/index', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TOKEN'
  },
  body: JSON.stringify({
    documents: [{
      id: 'doc_1',
      content: 'Rust is a systems programming language'
    }]
  })
});

// 4. Create task for agent
const task = await fetch('/api/v1/tasks', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TOKEN'
  },
  body: JSON.stringify({
    title: 'Analyze Rust documentation',
    assigned_to: ['research_agent'],
    metadata: { document_id: 'doc_1' }
  })
}).then(r => r.json());

// 5. Search for related content
const results = await fetch('/api/v1/vector/search', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TOKEN'
  },
  body: JSON.stringify({
    query: embedding.embedding,
    top_k: 10
  })
}).then(r => r.json());

console.log('Found', results.count, 'similar documents');
```

---

## SDKs

### TypeScript SDK

```bash
npm install @openclaw/mythos-sdk
```

```typescript
import { MythosClient } from '@openclaw/mythos-sdk';

const client = new MythosClient({
  baseUrl: 'http://localhost:18789',
  token: 'YOUR_TOKEN'
});

// Vector search
const results = await client.vector.search(queryVector, 10);

// Text search
const docs = await client.search.query('Rust programming');

// Embed text
const embedding = await client.embedding.embed('Hello world');
```

### Python SDK

```bash
pip install mythos-sdk
```

```python
from mythos import MythosClient

client = MythosClient(
    base_url='http://localhost:18789',
    token='YOUR_TOKEN'
)

# Vector search
results = client.vector.search(query_vector, top_k=10)

# Text search
docs = client.search.query('Rust programming')
```

---

## API Versioning

The API uses URL-based versioning:

- `/api/v1/` - Current stable version
- `/api/v2/` - Next version (in development)

Breaking changes are introduced only in major versions.

---

## Support

- **Documentation:** https://docs.openclaw.ai
- **Issues:** https://github.com/openclaw/openclaw/issues
- **Discord:** https://discord.gg/openclaw

---

## License

MIT License - See LICENSE for details.
