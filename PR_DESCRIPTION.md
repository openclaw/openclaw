# feat(memory): BrainClaw - Cognitive Hybrid Memory with AMHR & Gemini Support

## Summary

BrainClaw (formerly `memory-hybrid`) is a cognitive memory layer that replicates human-like recall patterns. It features **Associative Multi-Hop Retrieval (AMHR)**, **7-channel hybrid scoring**, and **Conversation Stacks** to provide agents with a persistent, evolving personality.

### 🧠 The Cognitive Parallel (The "Why")

- **Hippocampus**: `WorkingMemoryBuffer` filters noise, promoting only important facts.
- **Associative Cortex**: `AMHR` jumps through Knowledge Graph links to find related info.
- **Synaptic Plasticity**: `Reinforcement Scoring` makes frequently used facts "sticky".
- **Self-Identity**: `Reflection Engine` builds a holistic user profile from facts.

## Motivation

The current `memory-lancedb` plugin uses pure vector similarity (static recall). BrainClaw addresses this by:

1. Adding **free** embedding via Google Gemini (1K req/day) + chat (14.4K req/day)
2. Producing **higher quality recall** through 7-channel hybrid scoring
3. **Understanding relationships** via a Knowledge Graph and AMHR
4. **Self-correcting** — contradictory facts are detected and resolved
5. **Stability** — fixed `TypeError: 'set' on proxy` bug in multi-retrieval and zero-latency system short-circuits
6. **User profiles** — generates personas from accumulated memories (Reflection)
7. **Context Management** — Conversation Stack compresses turns to prevent token exhaustion
8. Maintaining full backward compatibility with existing LanceDB storage

## What's New

### Cognitive Architecture Features

| Feature                      | Description                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Batch Summarization**      | **(New)** Compresses context in groups of 3+, reducing API RPM by ~66-80%.                                        |
| **Deep Observability**       | **(New)** Real-time JSONL monitor (`monitor.ts`) and structured `MemoryTracer` for all lifecycle events.          |
| **Knowledge Graph**          | Extracts entities + relationships from memories via LLM (now uses batch extraction for 5x efficiency).            |
| **Hybrid Scoring (V2)**      | `0.42·Vector + 0.16·Importance + 0.10·Recency + 0.10·Temporal + 0.08·Graph + 0.08·Reinforcement + 0.06·Emotional` |
| **Candidate Preservation**   | **(New)** Ranks across 50-70 candidates before slicing, ensuring temporal/importance signals aren't lost early.   |
| **Conversation Stack**       | Compresses context into ~30-word summaries (17x compression).                                                     |
| **Smart Capture**            | LLM extracts individual facts from conversation (not whole messages).                                             |
| **Working Memory Buffer**    | Short-term buffer with promotion criteria.                                                                        |
| **Memory Reflection**        | Generates high-level user profile from all memories.                                                              |
| **Contradiction Resolution** | Detects conflicting facts and updates accordingly (PHOENIX Logic).                                                |
| **Google Gemini**            | Free embeddings (`gemini-embedding-001`) + chat (`gemma-3-27b-it`).                                               |
| **Lifecycle Protection**     | **(New)** Atomic `DreamService` start/stop guards to prevent orphaned background intervals and token waste.       |

### Key Additions:

- `stack.ts`: **Batch Summarization** buffer. Reduces LLM calls significantly by condensing history only when the buffer is full.
- `tracer.ts`: **Deep Trace Engine**. Provides typed helpers for `memory_recall`, `memory_store`, and `graph_update`.
- `scripts/monitor.ts`: **Memory Dashboard**. A real-time CLI tool to visualize what the bot is thinking/recalling.
- `index.ts`: **Batch Recall Flush**. Persists reinforcement counts in bulk to minimize database overhead and concurrency lockouts.
- `chat.ts`: **Semantic Contradiction Resolution** (PHOENIX) with strict Grounding and **Gemma 3 API Latency Fix**.

### Tools

| Tool             | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `memory_recall`  | Search memories (hybrid scoring + graph enrichment)   |
| `memory_store`   | Store memory (graph extraction + contradiction check) |
| `memory_forget`  | Delete memory (GDPR-compliant)                        |
| `memory_reflect` | Generate user profile from all memories               |

### CLI Commands

```bash
# Plugin specific tools
openclaw ltm list        # Memory count
openclaw ltm search      # Hybrid search
openclaw ltm graph       # Graph stats
openclaw ltm consolidate # Merge similar memories

# Observability (New)
bun extensions/memory-hybrid/scripts/monitor.ts # Real-time DASHBOARD
```

## Files Changed

All files are **new** or optimized — `extensions/memory-hybrid/` directory.

| File                 | Lines | Purpose                                     |
| -------------------- | ----- | ------------------------------------------- |
| `index.ts`           | ~1100 | Plugin entry — tools, hooks, CLI, AMHR, I/O |
| `buffer.ts`          | ~250  | Working Memory Buffer                       |
| `capture.ts`         | ~220  | Rule-based + Smart Capture                  |
| `chat.ts`            | ~200  | LLM client with retry (OpenAI + Google)     |
| `consolidate.ts`     | ~150  | Memory clustering + LLM merging             |
| `embeddings.ts`      | ~90   | OpenAI + Google embedding API               |
| `graph.ts`           | ~280  | Knowledge Graph + LLM extraction            |
| `recall.ts`          | ~170  | 7-channel hybrid scoring                    |
| `stack.ts`           | ~140  | Conversation Stack & Batch Compression      |
| `tracer.ts`          | ~90   | Deep JSONL observability logging            |
| `scripts/monitor.ts` | ~80   | Real-time CLI Dashboard                     |

## Tests

**121 tests passing** across 16 test files. Verified SOTA architecture compliance and API retry logic.

```bash
# Run tests
pnpm exec vitest run extensions/memory-hybrid/ --config vitest.extensions.config.ts
```

## Configuration

### Google Gemini (Free)

```json
{
  "plugins": {
    "slots": { "memory": "memory-hybrid" },
    "entries": {
      "memory-hybrid": {
        "enabled": true,
        "config": {
          "embedding": {
            "apiKey": "${GEMINI_API_KEY}",
            "model": "gemini-embedding-001"
          },
          "autoRecall": true,
          "autoCapture": true,
          "smartCapture": true
        }
      }
    }
  }
}
```

### OpenAI

```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "text-embedding-3-small"
  }
}
```

## API Compatibility

Uses the same plugin hooks (`before_agent_start`, `agent_end`), tools (`registerTool`), CLI (`registerCli`), and `prependContext` as `memory-lancedb`. No breaking changes.
