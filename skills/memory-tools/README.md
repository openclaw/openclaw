# memory-tools

> Enhanced vector search and hybrid retrieval for OpenClaw chat history. Fixes LanceDB's weak full-text search for non-English languages.

**Author:** [Arthur Arsyonov](https://looi.ru) · **License:** MIT

## The Problem

OpenClaw's built-in memory-lancedb uses OpenAI embeddings and basic text matching. For non-English languages (Russian, German, etc.), full-text search is near-useless — no stemming, no morphology, no proper tokenization.

## The Solution

A set of Python scripts that build a parallel search index with:

- **Google Gemini embeddings** (3072-dim) with automatic Ollama fallback
- **SQLite FTS5** for proper lexical search with language-aware tokenization
- **Hybrid scoring** that fuses vector similarity with lexical relevance

## Quick Start

```bash
# 1. Install dependency
pip3 install numpy

# 2. Build the vector index over your chat history
python3 build_vector_index.py

# 3. Search
python3 search_history_fast.py "how did we fix the auth bug" 10

# Or use the shell wrapper
./search_history.sh "auth bug fix" 10
```

## Scripts

| Script | Purpose |
|--------|---------|
| `build_vector_index.py` | Chunks LCM chat history → Google/Ollama embeddings → SQLite |
| `search_history_fast.py` | Hybrid vector+FTS5 search with numpy memmap |
| `unified_search.py` | Multi-source search (vectors + entity graph + LCM) |
| `search_history.sh` | Shell wrapper for `search_history_fast.py` |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server for fallback embeddings |

Google API key is read from `~/.openclaw/openclaw.json` → `env.vars.GOOGLE_AI_API_KEY`.

## How It Works

1. **Indexing:** `build_vector_index.py` reads all messages from `~/.openclaw/lcm.db`, chunks them (600 chars, 100 overlap), and embeds via Google's `gemini-embedding-2-preview`. Falls back to Ollama `nomic-embed-text` if Google is unavailable.

2. **Search:** `search_history_fast.py` runs a hybrid query:
   - Vector path: cosine similarity over numpy memmap (fast, no full DB scan)
   - Lexical path: FTS5 `MATCH` over chunked text
   - Fusion: `0.65 * vector_score + 0.35 * lexical_score`

3. **Unified:** `unified_search.py` orchestrates across vector DB, entity graph (if available), and raw LCM memory.

## Requirements

- Python 3.10+
- numpy
- OpenClaw with LCM database
- Google AI API key (recommended) or local Ollama

## Related

- [Full guide on looi.ru](https://looi.ru/a/looi-clawd) — detailed walkthrough of the memory architecture
- [OpenClaw memory-lancedb](https://github.com/openclaw/openclaw/tree/main/extensions/memory-lancedb) — the built-in plugin these scripts enhance
