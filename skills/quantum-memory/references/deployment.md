# Deployment Guide

## Microservice Setup

Run QMG as a shared API server for multiple agents:

```bash
pip install quantum-memory-graph[api]

# Default model (lightweight)
python -m quantum_memory_graph.api --port 8502

# High accuracy (GPU recommended)
QMG_MODEL=thenlper/gte-large python -m quantum_memory_graph.api --port 8502
```

## API Endpoints

- `POST /store` — `{"text": "memory content", "source": "agent-1"}`
- `POST /recall` — `{"query": "what to find", "K": 5}`
- `POST /store-batch` — `{"texts": ["mem1", "mem2", ...]}` (10x faster)
- `GET /stats` — Graph statistics
- `GET /` — Health check

## Migrate from Mem0

```python
from quantum_memory_graph import store

# Export from Mem0 (PostgreSQL)
import psycopg2
conn = psycopg2.connect("postgresql://...")
cur = conn.cursor()
cur.execute("SELECT content, metadata FROM memories")

for content, metadata in cur.fetchall():
    store(content, metadata=metadata)
```

## Migrate from LangChain Memory

```python
from quantum_memory_graph import store

# From ConversationBufferMemory
for msg in langchain_memory.chat_memory.messages:
    store(msg.content, source="langchain_import")
```

## Production Tips

- **Shared server**: One instance serves all agents within the same trust boundary. ⚠️ **Single-user/team only** — all agents share one knowledge graph. For multi-tenant deployments, run separate instances or namespace by user ID to prevent cross-user memory access.
- **Model choice**: `gte-large` on GPU servers, `MiniLM` on laptops/CI.
- **Batch import**: Use `/store-batch` for bulk migration — 10x faster.
- **Persistence**: Graph saves to disk automatically. Restarts preserve all memories.
- **Monitoring**: Hit `GET /stats` for node/edge counts, density, components.
