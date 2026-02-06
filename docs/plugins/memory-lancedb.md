---
summary: "Memory (LanceDB) plugin: vector-backed long-term memory with auto-recall/capture, OpenAI or local embeddings"
read_when:
  - You want long-term memory that persists across conversations
  - You are configuring the memory-lancedb plugin
  - You want to use local/offline embeddings for memory
title: "Memory (LanceDB) Plugin"
---

# Memory (LanceDB)

Vector-backed long-term memory for OpenClaw. Stores memories in a local
LanceDB database and retrieves them via semantic search. Supports
auto-recall (inject relevant memories before each conversation) and
auto-capture (save important information automatically).

Two embedding providers:

- `openai` — OpenAI API (`text-embedding-3-small` / `text-embedding-3-large`)
- `local` — offline via [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) (GGUF models)

## Enable

Set the memory slot to `memory-lancedb` in your config:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-lancedb"
    }
  }
}
```

## Config

Configuration lives under `plugins.entries.memory-lancedb.config`:

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb": {
        "config": {
          "embedding": {
            "provider": "openai",
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-small"
          },
          "autoCapture": true,
          "autoRecall": true
        }
      }
    }
  }
}
```

### Local embeddings (offline)

For fully offline operation, use the `local` provider with a GGUF model:

```json
{
  "embedding": {
    "provider": "local",
    "model": "hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.f16.gguf"
  }
}
```

The model is auto-downloaded on first use. You can also point to a local
file:

```json
{
  "embedding": {
    "provider": "local",
    "model": "~/models/nomic-embed.gguf"
  },
  "local": {
    "modelCacheDir": "~/.cache/llama-embeddings"
  }
}
```

Provider auto-detection: if `provider` is omitted, models ending in `.gguf`
or starting with `hf:` are treated as local; everything else defaults to
OpenAI.

### Config reference

| Key                   | Type                    | Default                      | Description                                                            |
| --------------------- | ----------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `embedding.provider`  | `"openai"` \| `"local"` | `"openai"`                   | Embedding backend                                                      |
| `embedding.apiKey`    | string                  | —                            | OpenAI API key (supports `${ENV_VAR}` syntax). Not required for local. |
| `embedding.model`     | string                  | `text-embedding-3-small`     | Embedding model name or path                                           |
| `local.modelPath`     | string                  | —                            | Explicit path to a GGUF model file                                     |
| `local.modelCacheDir` | string                  | —                            | Directory for cached model downloads                                   |
| `dbPath`              | string                  | `~/.openclaw/memory/lancedb` | LanceDB database directory                                             |
| `autoCapture`         | boolean                 | `true`                       | Auto-capture important info from conversations                         |
| `autoRecall`          | boolean                 | `true`                       | Auto-inject relevant memories into context                             |

## Agent tools

The plugin registers three tools available to the agent:

- **memory_recall** — search memories by semantic similarity
- **memory_store** — save a new memory (with category and importance)
- **memory_forget** — delete a memory by ID or search query

## CLI

```bash
openclaw ltm list          # show memory count
openclaw ltm search <q>    # semantic search (--limit N)
openclaw ltm stats         # database statistics
openclaw ltm reindex       # re-embed all memories with current provider
```

Use `ltm reindex` after switching embedding providers (e.g. OpenAI to local)
to rebuild vectors. The plugin detects dimension mismatches on startup and
will prompt you to reindex if needed.

## Switching embedding providers

OpenAI and local models produce vectors with different dimensions (1536 vs
768). If you change providers on an existing database, the plugin will detect
the mismatch and refuse to start until you run `openclaw ltm reindex` to
re-embed all stored memories with the new provider.
