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
| **Knowledge Graph**          | Extracts entities + relationships from memories via LLM                                                           |
| **AMHR**                     | Associative Multi-Hop Retrieval across the Knowledge Graph                                                        |
| **Hybrid Scoring**           | `0.42·Vector + 0.16·Importance + 0.10·Recency + 0.10·Temporal + 0.08·Graph + 0.08·Reinforcement + 0.06·Emotional` |
| **Conversation Stack**       | Compresses context into ~30-word summaries (17x compression)                                                      |
| **Smart Capture**            | LLM extracts individual facts from conversation (not whole messages)                                              |
| **Working Memory Buffer**    | Short-term buffer with promotion criteria                                                                         |
| **Memory Reflection**        | Generates high-level user profile from all memories                                                               |
| **Memory Consolidation**     | Merges similar/duplicate memories into stronger facts                                                             |
| **Contradiction Resolution** | Detects conflicting facts and updates accordingly                                                                 |
| **Google Gemini**            | Free embeddings (`gemini-embedding-001`) + chat (`gemma-3-27b-it`)                                                |
| **Prompt Injection Defense** | Mitigates malicious injection within stored context                                                               |

### Tools

| Tool             | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `memory_recall`  | Search memories (hybrid scoring + graph enrichment)   |
| `memory_store`   | Store memory (graph extraction + contradiction check) |
| `memory_forget`  | Delete memory (GDPR-compliant)                        |
| `memory_reflect` | Generate user profile from all memories               |

### CLI Commands

```bash
openclaw ltm list        # Memory count
openclaw ltm search      # Hybrid search
openclaw ltm graph       # Graph stats
openclaw ltm stats       # Overall statistics
openclaw ltm consolidate # Merge similar memories
openclaw ltm reflect     # Generate user profile
```

## Files Changed

All files are **new** — `extensions/memory-hybrid/` directory only. Zero modifications to existing code.

| File             | Lines | Purpose                                 |
| ---------------- | ----- | --------------------------------------- |
| `index.ts`       | ~950  | Plugin entry — tools, hooks, CLI, AMHR  |
| `buffer.ts`      | ~250  | Working Memory Buffer                   |
| `capture.ts`     | ~210  | Rule-based + Smart Capture              |
| `chat.ts`        | ~200  | LLM client with retry (OpenAI + Google) |
| `config.ts`      | ~200  | Configuration schema + validation       |
| `consolidate.ts` | ~150  | Memory clustering + LLM merging         |
| `embeddings.ts`  | ~90   | OpenAI + Google embedding API           |
| `graph.ts`       | ~280  | Knowledge Graph + LLM extraction        |
| `recall.ts`      | ~170  | 7-channel hybrid scoring                |
| `reflection.ts`  | ~130  | User profile generation                 |
| `stack.ts`       | ~130  | Conversation Stack & Compression        |
| `tracer.ts`      | ~70   | Out-of-band JSONL observability logging |
| `README.md`      | ~250  | Documentation                           |

## Tests

**121 tests passing** across 16 test files:

| Test Group               | Focus Area                                                            |
| ------------------------ | --------------------------------------------------------------------- |
| `index.test.ts`          | Plugin structure, config parsing, capture logic, injection protection |
| `sota-architecture.test` | Compliance with SOTA cognitive design patterns                        |
| `amhr.test.ts`           | Associative Multi-Hop Retrieval jump logic                            |
| `buffer.test.ts`         | Buffer lifecycle, promotion, eviction                                 |
| `consolidate.test.ts`    | Cosine similarity, clustering                                         |
| `graph.test.ts`          | Multi-hop traversal, edge dedup                                       |
| `chat.test.ts`           | Contradiction detection, error handling                               |
| `plugin.hook.test.ts`    | Cold-start latency / Short-circuit verifications                      |
| `stack.test.ts`          | Conversation turn compression logic                                   |
| `tracer.test.ts`         | Async file queue writes                                               |

```bash
# Run tests
vitest run extensions/memory-hybrid/ --config vitest.extensions.config.ts
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
