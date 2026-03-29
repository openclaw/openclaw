---
title: "QMD Memory Engine"
summary: "Local-first search sidecar with BM25, vectors, reranking, and query expansion"
read_when:
  - You want to set up QMD as your memory backend
  - You want advanced memory features like reranking or extra indexed paths
---

# QMD Memory Engine

[QMD](https://github.com/tobi/qmd) is a local-first search sidecar that runs
alongside OpenClaw. It combines BM25, vector search, and reranking in a single
binary, and can index content beyond your workspace memory files.

## What it adds over builtin

- **Reranking and query expansion** for better recall.
- **Index extra directories** -- project docs, team notes, anything on disk.
- **Index session transcripts** -- recall earlier conversations.
- **Fully local** -- runs via Bun + node-llama-cpp, auto-downloads GGUF models.
- **Automatic fallback** -- if QMD is unavailable, OpenClaw falls back to the
  builtin engine.

## Getting started

### Prerequisites

- Install QMD: `bun install -g https://github.com/tobi/qmd`
- SQLite build that allows extensions (`brew install sqlite` on macOS).
- QMD must be on the gateway's `PATH`.

### Enable

```json5
{
  memory: {
    backend: "qmd",
  },
}
```

OpenClaw creates a self-contained QMD home under
`~/.openclaw/agents/<agentId>/qmd/` and manages the sidecar lifecycle
automatically.

## Indexing extra paths

Point QMD at additional directories to make them searchable:

```json5
{
  memory: {
    backend: "qmd",
    qmd: {
      paths: [{ name: "docs", path: "~/notes", pattern: "**/*.md" }],
    },
  },
}
```

## Indexing session transcripts

Enable session indexing to recall earlier conversations:

```json5
{
  memory: {
    backend: "qmd",
    qmd: {
      sessions: { enabled: true },
    },
  },
}
```

Transcripts are exported and indexed in a dedicated QMD collection.

## When to use

Choose QMD when you need:

- Reranking for higher-quality results.
- To search project docs or notes outside the workspace.
- To recall past session conversations.
- Fully local search with no API keys.

For simpler setups, the [builtin engine](/concepts/memory-builtin) works well
with no extra dependencies.

## Configuration

For the full config surface (`memory.qmd.*`), search modes, update intervals,
scope rules, and all other knobs, see the
[Memory configuration reference](/reference/memory-config).
