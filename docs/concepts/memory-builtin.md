---
title: "Builtin Memory Engine"
summary: "The default SQLite-based memory backend with keyword, vector, and hybrid search"
read_when:
  - You want to understand the default memory backend
  - You want to configure embedding providers or hybrid search
---

# Builtin Memory Engine

The builtin engine is the default memory backend. It stores your memory index in
a per-agent SQLite database and needs no extra dependencies to get started.

## What it provides

- **Keyword search** via FTS5 full-text indexing (BM25 scoring).
- **Vector search** via embeddings from OpenAI, Gemini, Voyage, Mistral, Ollama,
  or a local GGUF model.
- **Hybrid search** that combines both for best results.
- **CJK support** via trigram tokenization.
- **sqlite-vec acceleration** for in-database vector queries (optional, falls
  back to in-process cosine similarity).

## Getting started

If you have an API key for OpenAI, Gemini, Voyage, or Mistral, the builtin
engine auto-detects it and enables vector search. No config needed.

To set a provider explicitly:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "openai",
      },
    },
  },
}
```

Without an embedding provider, only keyword search is available.

## Index location

The index lives at `~/.openclaw/memory/<agentId>.sqlite`. Reindex anytime with:

```bash
openclaw memory index --force
```

## When to use

The builtin engine is the right choice for most users. It works out of the box,
has no external dependencies, and handles keyword + vector search well.

Consider switching to [QMD](/concepts/memory-qmd) if you need reranking, query
expansion, or want to index directories outside the workspace.

## Configuration

For embedding provider setup, hybrid search tuning (weights, MMR, temporal
decay), batch indexing, multimodal memory, sqlite-vec, and all other config
knobs, see the [Memory configuration reference](/reference/memory-config).
