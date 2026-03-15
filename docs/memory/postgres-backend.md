# PostgreSQL Memory Backend

An alternative memory backend that stores and searches memory documents in PostgreSQL with pgvector, replacing the SQLite-based builtin backend.

## Why PostgreSQL?

- **No subprocess overhead** — direct DB queries instead of shelling out to QMD CLI
- **No binary dependencies** — no QMD, no Bun, no GGUF model downloads
- **Battle-tested infrastructure** — pgvector is used in production by thousands of companies
- **Multi-instance support** — multiple OpenClaw instances can share one memory database
- **Lower resource usage** — no local embedding models eating RAM/CPU on constrained hosts
- **Easy debugging** — `psql` to inspect state vs. parsing SQLite + subprocess logs

## Prerequisites

- PostgreSQL 15+ with pgvector extension
- An embedding provider API key (OpenAI, Voyage, Gemini, or Ollama)

### Install pgvector

```bash
# Ubuntu/Debian
sudo apt install postgresql-16-pgvector

# macOS (Homebrew)
brew install pgvector

# Docker
docker run -e POSTGRES_PASSWORD=secret pgvector/pgvector:pg16
```

## Configuration

In your OpenClaw config (`~/.openclaw/config.json`):

```json
{
  "memory": {
    "backend": "postgres",
    "postgres": {
      "connectionString": "postgres://user:password@localhost:5432/openclaw_memory",
      "embeddingProvider": "openai",
      "embeddingModel": "text-embedding-3-small",
      "embeddingDimensions": 1536,
      "indexType": "hnsw",
      "maxConnections": 5,
      "minSimilarity": 0.3
    }
  }
}
```

Or via environment variable:

```bash
export OPENCLAW_MEMORY_PG=postgres://user:password@localhost:5432/openclaw_memory
```

## How It Works

1. **File Sync**: Memory files (MEMORY.md, memory/\*.md) are chunked into ~30-line segments with 5-line overlap
2. **Embedding**: Each chunk is embedded using your configured provider
3. **Storage**: Chunks + embeddings stored in PostgreSQL with pgvector
4. **Search**: Queries are embedded and matched using cosine similarity (vector search) with FTS fallback
5. **Hybrid**: If vector search returns no results, falls back to PostgreSQL full-text search (tsvector/tsquery)

## Schema

The backend creates these tables automatically:

- `memory_files` — tracks synced files (path, hash, mtime)
- `memory_chunks` — text chunks with vector embeddings
- HNSW or IVFFlat index on the embedding column

Multi-agent safe: all records are scoped by `agent_id`.

## Comparison

| Feature          | Builtin (SQLite) | QMD                   | PostgreSQL               |
| ---------------- | ---------------- | --------------------- | ------------------------ |
| Dependencies     | Node.js only     | QMD CLI + models      | PostgreSQL + pgvector    |
| Embedding        | sqlite-vec       | Local GGUF            | API-based (OpenAI, etc.) |
| Resource usage   | Low (local)      | High (local models)   | Low (API calls)          |
| Multi-instance   | ❌ (file lock)   | ❌                    | ✅                       |
| Cold start       | Fast             | Slow (model download) | Fast                     |
| Offline          | ✅               | ✅                    | ❌ (needs API)           |
| Setup complexity | None             | Medium                | Low-Medium               |

## Troubleshooting

### "pgvector extension not found"

Install pgvector for your PostgreSQL version:

```bash
sudo apt install postgresql-16-pgvector
```

### "No embedding provider configured"

Set an API key for your embedding provider:

```bash
export OPENAI_API_KEY=sk-...
```

### Vector index creation deferred

This is normal — HNSW/IVFFlat indexes need data before they can be created efficiently. The index will be created on the next sync after chunks are inserted.
