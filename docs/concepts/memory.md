---
title: "Memory"
summary: "How OpenClaw remembers things across sessions"
read_when:
  - You want to understand how memory works
  - You want to know what memory files to write
---

# Memory

OpenClaw remembers things by writing **plain Markdown files** in your agent's
workspace. The model only "remembers" what gets saved to disk -- there is no
hidden state.

## How it works

Your agent has two places to store memories:

- **`MEMORY.md`** -- long-term memory. Durable facts, preferences, and
  decisions. Loaded at the start of every DM session.
- **`memory/YYYY-MM-DD.md`** -- daily notes. Running context and observations.
  Today and yesterday's notes are loaded automatically.

These files live in the agent workspace (default `~/.openclaw/workspace`).

<Tip>
If you want your agent to remember something, just ask it: "Remember that I
prefer TypeScript." It will write it to the appropriate file.
</Tip>

## Memory tools

The agent has two tools for working with memory:

- **`memory_search`** -- finds relevant notes using semantic search, even when
  the wording differs from the original.
- **`memory_get`** -- reads a specific memory file or line range.

Both tools are provided by the active memory plugin (default: `memory-core`).

## Memory search

When an embedding provider is configured, `memory_search` uses **hybrid
search** -- combining vector similarity (semantic meaning) with keyword matching
(exact terms like IDs and code symbols). This works out of the box once you have
an API key for any supported provider.

<Info>
OpenClaw auto-detects your embedding provider from available API keys. If you
have an OpenAI, Gemini, Voyage, or Mistral key configured, memory search is
enabled automatically.
</Info>

For details on how search works, tuning options, and provider setup, see
[Memory Search](/concepts/memory-search).

## Memory backends

OpenClaw has two backends for indexing and searching memory:

<CardGroup cols={2}>
<Card title="Builtin (default)" icon="database" href="/concepts/memory-builtin">
SQLite-based. Works out of the box with keyword search, vector similarity, and
hybrid search. No extra dependencies.
</Card>
<Card title="QMD" icon="magnifying-glass" href="/concepts/memory-qmd">
Local-first sidecar with reranking, query expansion, and the ability to index
directories outside the workspace.
</Card>
</CardGroup>

## Automatic memory flush

Before [compaction](/concepts/compaction) summarizes your conversation, OpenClaw
runs a silent turn that reminds the agent to save important context to memory
files. This is on by default -- you do not need to configure anything.

<Tip>
The memory flush prevents context loss during compaction. If your agent has
important facts in the conversation that are not yet written to a file, they
will be saved automatically before the summary happens.
</Tip>

## CLI

```bash
openclaw memory status          # Check index status and provider
openclaw memory search "query"  # Search from the command line
openclaw memory index --force   # Rebuild the index
```

## Further reading

- [Builtin Memory Engine](/concepts/memory-builtin) -- default SQLite backend
- [QMD Memory Engine](/concepts/memory-qmd) -- advanced local-first sidecar
- [Memory Search](/concepts/memory-search) -- search pipeline, providers, and
  tuning
- [Memory configuration reference](/reference/memory-config) -- all config knobs
- [Compaction](/concepts/compaction) -- how compaction interacts with memory
