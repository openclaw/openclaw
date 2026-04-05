---
name: supermemory
description: Unified 5-layer persistent memory system combining RAG (ChromaDB), tiered memory (hot/warm/cold), episodic memory (task trajectories), step-level experience (SLEA-RL), and garbage collection. Use when discussing memory architecture, recall, persistence, or few-shot retrieval.
metadata:
  openclaw:
    emoji: "🧠"
    category: ai
---

# SuperMemory

Unified persistent memory combining five layers into a single entry point (`src/supermemory.py`).

## Architecture

```
SuperMemory
├── RAG Engine (ChromaDB)
│   ├── cosine similarity search
│   ├── PersistentClient (data/supermemory/rag/)
│   └── Collection: openclaw_supermemory
├── Tiered Memory (SQLite-backed)
│   ├── Hot  (≤8000 tokens) — active context, highest priority
│   ├── Warm (≤16000 tokens) — recent but less active (demote after 4h)
│   └── Cold — archived (archive after 24h, compressible)
├── Episodic Memory
│   ├── Full task trajectories (task → steps → reward)
│   └── Few-shot retrieval for similar future tasks
├── Step-Level Experience (SLEA-RL, arXiv:2603.18079)
│   ├── Per-step: role, action, observation, reward
│   └── Fine-grained retrieval vs. full episode
└── Garbage Collector
    ├── Demotes hot→warm→cold by last_access time
    ├── Compresses cold memories
    └── Prunes by importance when over token budget
```

## Core API

```python
mem = SuperMemory(persist_dir="data/supermemory")
mem.initialize()

# Store
mem.store("user_preference", "Prefers Python", importance=0.8)

# Recall (combines RAG + all tiers + episodes)
results: List[RecallResult] = mem.recall("What language?", top_k=5)

# Episodes
mem.record_episode("fix_bug", [{"action": "read", "result": "found"}], reward=1.0)

# GC
mem.gc()
```

## Data Classes

| Class            | Purpose                                                      |
| ---------------- | ------------------------------------------------------------ |
| `MemoryRecord`   | Single memory with tier, importance, source, access tracking |
| `EpisodeRecord`  | Complete task trajectory (steps + reward + success)          |
| `StepExperience` | SLEA-RL single step within an episode                        |
| `RecallResult`   | Single recall result with source + score                     |

## Token Budget

| Tier | Max Tokens | Lifecycle                    |
| ---- | ---------- | ---------------------------- |
| Hot  | 8000       | Active context               |
| Warm | 16000      | Demote after 4h inactivity   |
| Cold | Unlimited  | Archive after 24h, GC prunes |

## Persistence

- **SQLite**: `data/supermemory/supermemory.db` (WAL mode)
  - Tables: `memories`, `episodes`, `step_experiences`
  - Indexes: tier, importance DESC, task, episode_id, role
- **ChromaDB**: `data/supermemory/rag/` (cosine similarity, HNSW)

## Integration

- Used by `PipelineExecutor` for context injection before LLM calls
- `FeedbackLoopEngine` stores learned patterns via `store()`
- Brigade agents share memory scope via namespaced keys
- SAGE self-evolution reads episodic memory for introspection
