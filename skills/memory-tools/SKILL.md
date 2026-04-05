---
name: memory-tools
description: "Companion scripts for OpenClaw memory-lancedb: vector index builder with Google/Ollama embeddings, fast semantic search with FTS5 hybrid scoring, and unified multi-source search. Solves LanceDB's weak full-text search for non-English languages."
homepage: https://looi.ru/a/looi-clawd
metadata:
  author: Arthur Arsyonov
  license: MIT
---

# Memory Tools — Enhanced Search for OpenClaw

## Problem

OpenClaw's memory-lancedb plugin uses OpenAI embeddings only and has weak full-text search for non-English languages (no stemming, no morphology). For Russian and other inflected languages, recall is poor.

## Solution

Python scripts that build a parallel vector+FTS5 index over your chat history:

1. **build_vector_index.py** — Chunks all LCM chat history, embeds via Google `gemini-embedding-2-preview` (fallback: Ollama `nomic-embed-text`), stores in SQLite
2. **search_history_fast.py** — Hybrid search combining vector similarity + FTS5 lexical scoring with numpy memmap for speed
3. **unified_search.py** — Single entry point that searches vector DB + entity graph + LCM memory
4. **search_history.sh** — Shell wrapper for quick CLI use

## Requirements

- Python 3.10+
- numpy
- Google AI API key (for embeddings) OR local Ollama with `nomic-embed-text`
- OpenClaw with LCM database (`~/.openclaw/lcm.db`)

## Installation

```bash
# Place in your OpenClaw workspace
cp -r memory-tools/ ~/.openclaw/workspace/scripts/memory/

# Install dependencies
pip3 install numpy

# Build the index (first run takes a while)
python3 build_vector_index.py

# Search
./search_history.sh "your query here" 10
```

## Architecture

```
lcm.db (chat history)
  │
  ├─ build_vector_index.py ──→ chat_vectors.db (SQLite + FTS5)
  │     Google embeddings (primary)
  │     Ollama embeddings (fallback)
  │
  ├─ search_history_fast.py ──→ Hybrid vector+lexical search
  │     numpy memmap for fast cosine similarity
  │     FTS5 for morphology-aware text matching
  │     Score fusion: 0.65 * vector + 0.35 * lexical
  │
  └─ unified_search.py ──→ Multi-source orchestrator
        vector DB + entity graph + raw LCM
```

## Configuration

Set via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `GOOGLE_AI_API_KEY` | from `openclaw.json` | Google AI API key for embeddings |

## Key Numbers

- ~100K chunks indexed from chat history
- 3072-dimensional Google embeddings (1024 for Ollama fallback)
- Hybrid scoring: 65% vector + 35% lexical
- Search latency: <2s typical (with numpy memmap)
