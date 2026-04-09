---
title: "Memory Overview"
summary: "How OpenClaw remembers things across sessions"
read_when:
  - You want to understand how memory works
  - You want to know what memory files to write
---

# Memory Overview

OpenClaw remembers things by writing **plain Markdown files** in your agent's
workspace. The model only "remembers" what gets saved to disk -- there is no
hidden state.

## How it works

Your agent has three memory-related files:

- **`MEMORY.md`** -- long-term memory. Durable facts, preferences, and
  decisions. Loaded at the start of every DM session.
- **`memory/YYYY-MM-DD.md`** -- daily notes. Running context and observations.
  Today and yesterday's notes are loaded automatically.
- **`DREAMS.md`** (experimental, optional) -- Dream Diary and dreaming sweep
  summaries for human review.

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

## Canonical memory vs derived layers

OpenClaw's memory model works best when the source of truth stays obvious.

- **Canonical sources**: user-authored memory files, durable notes, and opted-in session transcripts.
- **Derived layers**: embeddings, search indexes, compaction summaries, wiki pages, dashboards, and other generated views.

Derived layers exist to make recall faster and more navigable. They are not the
primary record. If a derived view disagrees with the underlying file or
transcript, treat the underlying source as authoritative and repair or rebuild
the derived layer.

This distinction matters because memory quality usually degrades when summaries
or indexes silently replace original evidence instead of pointing back to it.

## Memory Wiki companion plugin

If you want durable memory to behave more like a maintained knowledge base than
just raw notes, use the bundled `memory-wiki` plugin.

`memory-wiki` compiles durable knowledge into a wiki vault with:

- deterministic page structure
- structured claims and evidence
- contradiction and freshness tracking
- generated dashboards
- compiled digests for agent/runtime consumers
- wiki-native tools like `wiki_search`, `wiki_get`, `wiki_apply`, and `wiki_lint`

It does not replace the active memory plugin. The active memory plugin still
owns recall, promotion, and dreaming. `memory-wiki` adds a provenance-rich
knowledge layer beside it.

See [Memory Wiki](/plugins/memory-wiki).

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

## Bootstrap vs deep recall

Keep the always-loaded memory surface small, then retrieve depth on demand.

- Put durable identity, preferences, and evergreen decisions in files like `MEMORY.md`.
- Let `memory_search` pull in detailed snippets only when they are relevant to the current task.
- Use compiled layers like `memory-wiki` to improve navigation and synthesis, not to bloat default prompt context.

This keeps startup context stable while still preserving access to the full raw record.

## Memory backends

<CardGroup cols={3}>
<Card title="Builtin (default)" icon="database" href="/concepts/memory-builtin">
SQLite-based. Works out of the box with keyword search, vector similarity, and
hybrid search. No extra dependencies.
</Card>
<Card title="QMD" icon="search" href="/concepts/memory-qmd">
Local-first sidecar with reranking, query expansion, and the ability to index
directories outside the workspace.
</Card>
<Card title="Honcho" icon="brain" href="/concepts/memory-honcho">
AI-native cross-session memory with user modeling, semantic search, and
multi-agent awareness. Plugin install.
</Card>
</CardGroup>

## Knowledge wiki layer

<CardGroup cols={1}>
<Card title="Memory Wiki" icon="book" href="/plugins/memory-wiki">
Compiles durable memory into a provenance-rich wiki vault with claims,
dashboards, bridge mode, and Obsidian-friendly workflows.
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

## Dreaming (experimental)

Dreaming is an optional background consolidation pass for memory. It collects
short-term signals, scores candidates, and promotes only qualified items into
long-term memory (`MEMORY.md`).

It is designed to keep long-term memory high signal:

- **Opt-in**: disabled by default.
- **Scheduled**: when enabled, `memory-core` auto-manages one recurring cron job
  for a full dreaming sweep.
- **Thresholded**: promotions must pass score, recall frequency, and query
  diversity gates.
- **Reviewable**: phase summaries and diary entries are written to `DREAMS.md`
  for human review.

For phase behavior, scoring signals, and Dream Diary details, see
[Dreaming (experimental)](/concepts/dreaming).

## CLI

```bash
openclaw memory status          # Check index status and provider
openclaw memory search "query"  # Search from the command line
openclaw memory index --force   # Rebuild the index
```

## Further reading

- [Builtin Memory Engine](/concepts/memory-builtin) -- default SQLite backend
- [QMD Memory Engine](/concepts/memory-qmd) -- advanced local-first sidecar
- [Honcho Memory](/concepts/memory-honcho) -- AI-native cross-session memory
- [Memory Wiki](/plugins/memory-wiki) -- compiled knowledge vault and wiki-native tools
- [Memory Search](/concepts/memory-search) -- search pipeline, providers, and
  tuning
- [Dreaming (experimental)](/concepts/dreaming) -- background promotion
  from short-term recall to long-term memory
- [Memory configuration reference](/reference/memory-config) -- all config knobs
- [Compaction](/concepts/compaction) -- how compaction interacts with memory
