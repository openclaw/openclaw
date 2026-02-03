# Docs Chat

Docs chatbot that uses RAG (Retrieval-Augmented Generation) to answer questions
from the OpenClaw documentation via semantic search.

## RAG Pipeline (Recommended)

The vector-based RAG pipeline uses OpenAI embeddings and LanceDB for semantic
search. This provides much better results than keyword matching.

### Build the vector index

```bash
OPENAI_API_KEY=sk-... pnpm docs:chat:index:vector
```

This generates embeddings for all doc chunks and stores them in
`scripts/docs-chat/.lance-db/` (gitignored).

### Run the RAG API

```bash
OPENAI_API_KEY=sk-... pnpm docs:chat:serve:vector
```

Defaults to `http://localhost:3001`. Health check:

```bash
curl http://localhost:3001/health
# Returns: {"ok":true,"chunks":N,"mode":"vector"}
```

## Legacy Keyword Pipeline

The original keyword-based implementation is still available for backward
compatibility.

### Build the keyword index

```bash
pnpm docs:chat:index
```

This generates `scripts/docs-chat/search-index.json` from `docs/**/*.md`.

### Run the keyword API

```bash
OPENAI_API_KEY=sk-... pnpm docs:chat:serve
```

## Pipeline Integration

CI rebuilds the keyword index whenever docs change so PRs keep
`scripts/docs-chat/search-index.json` in sync. For production deployments with
RAG, run `pnpm docs:chat:index:vector` during deploy.

## Mintlify widget

Mintlify loads any `.js` in the docs content directory on every page.
`docs/assets/docs-chat-widget.js` injects a floating "Ask Molty" button and
calls the API at:

```
window.DOCS_CHAT_API_URL || "http://localhost:3001"
```

To use a deployed API, set `window.DOCS_CHAT_API_URL` before the widget runs
(for example by adding another small `.js` file in `docs/assets/` that sets it).

## Architecture

```
docs/**/*.md
    │
    ▼
┌─────────────────┐
│ build-vector-   │  Chunking + OpenAI Embeddings
│ index.ts        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ .lance-db/      │  LanceDB Vector Store
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ serve.ts        │  Hybrid Retrieval (Vector + Keyword Boost)
│                 │  → GPT-4o-mini Streaming Response
└─────────────────┘
```
