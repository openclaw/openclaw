# feat(memory): add hybrid memory plugin with Knowledge Graph and free Gemini support

## Summary

Drop-in replacement for `memory-lancedb` that adds **Knowledge Graph**, **5-channel hybrid scoring**, **Smart Capture**, **Memory Reflection**, and **zero-cost Google Gemini support**.

## Motivation

The current `memory-lancedb` plugin uses pure vector similarity with OpenAI (paid). This limits recall quality and requires API costs. `memory-hybrid` addresses this by:

1. Adding **free** embedding via Google Gemini (1K req/day) + chat (14.4K req/day)
2. Producing **higher quality recall** through 5-channel hybrid scoring
3. **Understanding relationships** via a Knowledge Graph
4. **Self-correcting** — contradictory facts are detected and resolved
5. Generating **user profiles** from accumulated memories (Reflection)
6. Maintaining full backward compatibility with existing LanceDB storage

## What's New

### Core Features

| Feature                      | Description                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------- |
| **Knowledge Graph**          | Extracts entities + relationships from memories via LLM                          |
| **Hybrid Scoring**           | `0.50·Vector + 0.12·Recency + 0.18·Importance + 0.10·Graph + 0.10·Reinforcement` |
| **Smart Capture**            | LLM extracts individual facts from conversation (not whole messages)             |
| **Memory Reflection**        | Generates high-level user profile from all memories                              |
| **Memory Consolidation**     | Merges similar/duplicate memories into stronger facts                            |
| **Working Memory Buffer**    | Short-term buffer with promotion criteria                                        |
| **Contradiction Resolution** | Detects conflicting facts and updates accordingly                                |
| **Google Gemini**            | Free embeddings (`gemini-embedding-001`) + chat (`gemma-3-27b-it`)               |

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
| `index.ts`       | ~950  | Plugin entry — tools, hooks, CLI        |
| `config.ts`      | ~200  | Configuration schema + validation       |
| `embeddings.ts`  | ~90   | OpenAI + Google embedding API           |
| `chat.ts`        | ~200  | LLM client with retry (OpenAI + Google) |
| `graph.ts`       | ~280  | Knowledge Graph + LLM extraction        |
| `capture.ts`     | ~210  | Rule-based + Smart Capture              |
| `recall.ts`      | ~170  | 5-channel hybrid scoring                |
| `buffer.ts`      | ~250  | Working Memory Buffer                   |
| `consolidate.ts` | ~150  | Memory clustering + LLM merging         |
| `reflection.ts`  | ~130  | User profile generation                 |
| `README.md`      | ~160  | Documentation                           |

## Tests

**73 tests passing** across 5 test files:

| Test File             | Tests | Coverage                                                              |
| --------------------- | ----- | --------------------------------------------------------------------- |
| `index.test.ts`       | 32    | Plugin structure, config parsing, capture logic, injection protection |
| `buffer.test.ts`      | 15    | Buffer lifecycle, promotion, eviction                                 |
| `consolidate.test.ts` | 12    | Cosine similarity, clustering                                         |
| `graph.test.ts`       | 8     | Multi-hop traversal, edge dedup                                       |
| `chat.test.ts`        | 6     | Contradiction detection, error handling                               |

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
