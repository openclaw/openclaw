---
name: quantum-memory
description: Quantum-optimized memory retrieval for AI agents. Use when building agent memory systems, replacing Mem0/LangChain memory, or needing relationship-aware recall that finds connected memory clusters instead of individual matches. Triggers on memory system setup, agent memory upgrade, knowledge graph memory, QAOA optimization, recall quality improvement, short-term memory with recency boost. Installs via pip (quantum-memory-graph). Benchmarked on LongMemEval (ICLR 2025).
---

# Quantum Memory Graph

Relationship-aware memory for AI agents. Knowledge graphs + quantum-optimized subgraph selection (QAOA).

## When to Use

- Building or upgrading an AI agent's memory system
- Replacing flat similarity search (Mem0, LangChain memory, raw vector DB)
- Need memories that work *together* as connected context, not isolated matches
- Want recency-aware retrieval (recent memories rank higher)

## Install

```bash
pip install quantum-memory-graph
```

For high-accuracy mode (needs ~2GB RAM, GPU recommended):
```bash
pip install quantum-memory-graph
# Then use model="thenlper/gte-large" — 96.6% R@5
```

## Quick Start

```python
from quantum_memory_graph import store, recall

# Store memories — automatically builds knowledge graph
store("Project Alpha uses React frontend with TypeScript.")
store("Project Alpha backend is FastAPI with PostgreSQL.")
store("FastAPI connects to PostgreSQL via SQLAlchemy ORM.")

# Recall — graph traversal + QAOA finds the optimal combination
result = recall("What is Project Alpha's full tech stack?", K=4)
for memory in result["memories"]:
    print(f"  {memory['text']}")
```

## Model Selection

Read `references/models.md` for full comparison table.

- **Default** (`all-MiniLM-L6-v2`): 90MB, no GPU, 93.4% R@5. Use for laptops/CI.
- **High accuracy** (`thenlper/gte-large`): 1.3GB, GPU recommended, 96.6% R@5.

```python
from quantum_memory_graph import MemoryGraph
mg = MemoryGraph(model="thenlper/gte-large")
```

## Short-Term Memory (v0.4.0+)

Recency boost is ON by default. Recent memories score higher automatically.

```python
from quantum_memory_graph import store, recall, get_stm

store("User prefers dark mode")  # Gets recency boost

# Track conversation context
stm = get_stm()
stm.conversation.add_turn("What are preferences?", memory_ids=["m1"])
```

Three layers:
- **Recency**: +0.3 last hour, +0.15 last day, +0.05 last week
- **Working memory**: Last 20 memories always available
- **Conversation context**: Current topic gets priority

## Deploy as Microservice

```bash
pip install quantum-memory-graph[api]
python -m quantum_memory_graph.api --port 8502
```

Endpoints: `POST /store`, `POST /recall`, `POST /store-batch`, `GET /stats`

Multiple agents share one API server. See `references/deployment.md` for migration guide.

## Migrate from Mem0

```python
from quantum_memory_graph import store
for memory in existing_memories:
    store(memory["text"], metadata=memory.get("metadata"))
# Graph connections built automatically
```

## IBM Quantum Hardware

```bash
pip install quantum-memory-graph[ibm]
export IBM_QUANTUM_TOKEN=your_token
```

Runs QAOA on real quantum hardware (validated on ibm_fez, ibm_kingston).
