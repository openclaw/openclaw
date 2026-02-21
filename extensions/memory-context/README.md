# memory-context Plugin

> **This is an optional plugin for openclaw. It is disabled by default and must be explicitly enabled in configuration before it takes effect.** See [Enabling the Plugin](#enabling-the-plugin) below.

Cross-session conversation memory system. Automatically archives conversation content during compaction and smart-trim, then recalls relevant historical context in subsequent conversations via hybrid search (vector + BM25).

## Features

| Feature                  | Description                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Auto-archive**         | Automatically stores conversation segments to JSONL cold storage on compaction and smart-trim                         |
| **Hybrid search**        | Vector semantic search (70% weight) + BM25 keyword search (30% weight) with CJK bigram tokenization                   |
| **Auto-recall**          | Automatically searches and injects relevant history into context before prompt build                                  |
| **Noise filter**         | Filters out HEARTBEAT, NO_REPLY, audio metadata, and other non-meaningful content                                     |
| **Knowledge extraction** | Extracts durable technical facts from compacted messages (knowledge.jsonl)                                            |
| **Redaction**            | Masks API keys, tokens, and other secrets before storage                                                              |
| **Cross-session search** | Optionally search across all historical sessions (not limited to current session)                                     |
| **Vector persistence**   | Vector index persisted to vectors.bin — no recomputation on restart                                                   |
| **Background embedding** | Only loads BM25 index on startup; vector embeddings computed progressively in background without blocking the service |

## Enabling the Plugin

**This plugin is not active by default.** You must add the following configuration to `~/.openclaw/openclaw.json` to enable it:

```json
{
  "plugins": {
    "entries": {
      "memory-context": {
        "config": {}
      }
    },
    "slots": {
      "memory": "memory-context"
    }
  }
}
```

- `plugins.entries.memory-context` — Registers the plugin and passes configuration
- `plugins.slots.memory` — Binds `memory-context` to the memory slot (**required** — without this binding the plugin will not be invoked even if registered)

> **Both `entries` and `slots` are required.** If either is missing, the plugin remains inactive.

## Configuring Embedding API Key

The plugin supports multiple embedding models via the `embeddingModel` config option:

| Model              | Description                                                          | Requires API Key |
| ------------------ | -------------------------------------------------------------------- | ---------------- |
| `"auto"` (default) | Auto-selects best available: Gemini → OpenAI → Voyage → Local → BM25 | Depends          |
| `"transformer"`    | Local ONNX model (EmbeddingGemma-300M), no network required          | No               |
| `"gemini"`         | Equivalent to `"auto"`, prefers Gemini API                           | Yes              |
| `"hash"`           | Deterministic hash (keyword matching only, no semantic search)       | No               |

### Gemini API Key Configuration

Gemini embedding uses a Google API key. Resolution order:

1. **Environment variable** (recommended):

   ```bash
   export GEMINI_API_KEY="your-key-here"
   # or
   export GOOGLE_API_KEY="your-key-here"
   ```

2. **Auth profile in openclaw.json**:
   Add a Google auth profile under `auth.profiles` to let openclaw's API key rotation system manage it automatically.

> When using the default `"transformer"` model, **no API key is needed** — embeddings are computed entirely locally.

## Configuration Reference

All config options are optional. Place them under `plugins.entries.memory-context.config`:

```json
{
  "plugins": {
    "entries": {
      "memory-context": {
        "config": {
          "crossSession": true,
          "autoRecallMaxTokens": 12000,
          "embeddingModel": "auto"
        }
      }
    },
    "slots": {
      "memory": "memory-context"
    }
  }
}
```

### Core Options

| Option                | Type    | Default                      | Description                                                         |
| --------------------- | ------- | ---------------------------- | ------------------------------------------------------------------- |
| `autoRecall`          | boolean | `true`                       | Enable automatic recall of historical context                       |
| `autoRecallMaxTokens` | number  | `12000`                      | Maximum tokens for recalled context injection                       |
| `autoRecallMinScore`  | number  | `0.6`                        | Minimum relevance score for recall (0–1)                            |
| `crossSession`        | boolean | `false`                      | Search across all sessions (recommended to enable)                  |
| `maxSegments`         | number  | `20000`                      | Maximum segments in the warm store                                  |
| `embeddingModel`      | string  | `"auto"`                     | Embedding model: `"auto"` / `"transformer"` / `"gemini"` / `"hash"` |
| `embeddingModelName`  | string  | `"EmbeddingGemma-300M"`      | Local model name                                                    |
| `redaction`           | boolean | `true`                       | Redact secrets before storage                                       |
| `knowledgeExtraction` | boolean | `true`                       | Extract knowledge from compacted messages                           |
| `storagePath`         | string  | `~/.openclaw/memory/context` | Data storage path                                                   |

### Search Options

Place under `config.search`:

| Option         | Type   | Default | Description                                           |
| -------------- | ------ | ------- | ----------------------------------------------------- |
| `vectorWeight` | number | `0.7`   | Vector search weight                                  |
| `bm25Weight`   | number | `0.3`   | BM25 keyword search weight                            |
| `timeDecay`    | number | `0.995` | Time decay factor (lower values favor recent content) |

### Advanced Options

| Option                      | Type    | Default  | Description                                                        |
| --------------------------- | ------- | -------- | ------------------------------------------------------------------ |
| `evictionDays`              | number  | `90`     | Max retention days for warm store (0 = unlimited)                  |
| `vectorPersist`             | boolean | `true`   | Persist vector index to vectors.bin                                |
| `indexType`                 | string  | `"hnsw"` | Vector index type: `"hnsw"` (fast approximate) / `"brute"` (exact) |
| `embeddingDim`              | number  | `384`    | Embedding dimension (usually auto-detected, no need to set)        |
| `budget.maxTokens`          | number  | `4000`   | Output budget for recalled results                                 |
| `budget.tokenEstimateRatio` | number  | `3`      | Token estimation ratio                                             |

## Minimal Example

Enable with defaults (local model, no API key needed):

```json
{
  "plugins": {
    "entries": {
      "memory-context": { "config": {} }
    },
    "slots": {
      "memory": "memory-context"
    }
  }
}
```

## Recommended Configuration

```json
{
  "plugins": {
    "entries": {
      "memory-context": {
        "config": {
          "crossSession": true,
          "autoRecallMaxTokens": 12000,
          "autoRecallMinScore": 0.5
        }
      }
    },
    "slots": {
      "memory": "memory-context"
    }
  }
}
```

## Data Files

| File              | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `segments.jsonl`  | Conversation segment cold storage (one JSON record per line) |
| `vectors.bin`     | Vector index binary cache                                    |
| `knowledge.jsonl` | Extracted knowledge entries                                  |

Default storage location: `~/.openclaw/memory/context/`.
