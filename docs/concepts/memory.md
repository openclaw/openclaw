---
title: "Memory"
summary: "How OpenClaw memory works -- file layout, backends, search, and automatic flush"
read_when:
  - You want the memory file layout and workflow
  - You want to understand memory search and backends
  - You want to tune the automatic pre-compaction memory flush
---

# Memory

OpenClaw memory is **plain Markdown in the agent workspace**. The files are the
source of truth -- the model only "remembers" what gets written to disk.

Memory search tools are provided by the active memory plugin (default:
`memory-core`). Disable memory plugins with `plugins.slots.memory = "none"`.

## File layout

The default workspace uses two memory layers:

| Path                   | Purpose                  | Loaded at session start    |
| ---------------------- | ------------------------ | -------------------------- |
| `memory/YYYY-MM-DD.md` | Daily log (append-only)  | Today + yesterday          |
| `MEMORY.md`            | Curated long-term memory | Yes (main DM session only) |

If both `MEMORY.md` and `memory.md` exist at the workspace root, OpenClaw loads
both (deduplicated by realpath so symlinks are not injected twice). `MEMORY.md`
is only loaded in the main, private session -- never in group contexts.

These files live under the agent workspace (`agents.defaults.workspace`, default
`~/.openclaw/workspace`). See [Agent workspace](/concepts/agent-workspace) for
the full layout.

## When to write memory

- **Decisions, preferences, and durable facts** go to `MEMORY.md`.
- **Day-to-day notes and running context** go to `memory/YYYY-MM-DD.md`.
- If someone says "remember this," **write it down** (do not keep it in RAM).
- If you want something to stick, **ask the bot to write it** into memory.

## Memory tools

OpenClaw exposes two agent-facing tools:

- **`memory_search`** -- semantic recall over indexed snippets. Uses the active
  memory backend's search pipeline (vector similarity, keyword matching, or
  hybrid).
- **`memory_get`** -- targeted read of a specific Markdown file or line range.
  Degrades gracefully when a file does not exist (returns empty text instead of
  an error).

## Memory backends

OpenClaw supports two memory backends that control how `memory_search` indexes
and retrieves content:

### Builtin (default)

The builtin backend uses a per-agent SQLite database with optional extensions:

- **FTS5 full-text search** for keyword matching (BM25 scoring).
- **sqlite-vec** for in-database vector similarity (falls back to in-process
  cosine similarity when unavailable).
- **Hybrid search** combining BM25 + vector scores for best-of-both-worlds
  retrieval.
- **CJK support** via configurable trigram tokenization with short-substring
  fallback.

The builtin backend works out of the box with no extra dependencies. For
embedding vectors, configure an embedding provider (OpenAI, Gemini, Voyage,
Mistral, Ollama, or local GGUF). Without an embedding provider, only keyword
search is available.

Index location: `~/.openclaw/memory/<agentId>.sqlite`

### QMD (experimental)

[QMD](https://github.com/tobi/qmd) is a local-first search sidecar that
combines BM25 + vectors + reranking in a single binary. Set
`memory.backend = "qmd"` to opt in.

Key differences from the builtin backend:

- Runs as a subprocess (Bun + node-llama-cpp), auto-downloads GGUF models.
- Supports advanced post-processing: reranking, query expansion.
- Can index extra directories beyond the workspace (`memory.qmd.paths`).
- Can optionally index session transcripts (`memory.qmd.sessions`).
- Falls back to the builtin backend if QMD is unavailable.

QMD requires a separate install (`bun install -g https://github.com/tobi/qmd`)
and a SQLite build that allows extensions. See the
[Memory configuration reference](/reference/memory-config) for full setup.

## Memory search

When an embedding provider is configured, `memory_search` uses semantic vector
search to find relevant notes even when the wording differs from the query.
Hybrid search (BM25 + vector) is enabled by default when both FTS5 and
embeddings are available.

For details on how search works -- embedding providers, hybrid scoring, MMR
diversity re-ranking, temporal decay, and tuning -- see
[Memory Search](/concepts/memory-search).

### Embedding provider auto-selection

If `memorySearch.provider` is not set, OpenClaw auto-selects the first available
provider in this order:

1. `local` -- if `memorySearch.local.modelPath` is configured and exists.
2. `openai` -- if an OpenAI key can be resolved.
3. `gemini` -- if a Gemini key can be resolved.
4. `voyage` -- if a Voyage key can be resolved.
5. `mistral` -- if a Mistral key can be resolved.

If none can be resolved, memory search stays disabled until configured. Ollama
is supported but not auto-selected (set `memorySearch.provider = "ollama"`
explicitly).

## Additional memory paths

Index Markdown files outside the default workspace layout:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"],
      },
    },
  },
}
```

Paths can be absolute or workspace-relative. Directories are scanned
recursively for `.md` files. Symlinks are ignored.

## Multimodal memory (Gemini)

When using `gemini-embedding-2-preview`, OpenClaw can index image and audio
files from `memorySearch.extraPaths`:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "gemini",
        model: "gemini-embedding-2-preview",
        extraPaths: ["assets/reference", "voice-notes"],
        multimodal: {
          enabled: true,
          modalities: ["image", "audio"],
        },
      },
    },
  },
}
```

Search queries remain text, but Gemini can compare them against indexed
image/audio embeddings. `memory_get` still reads Markdown only.

See the [Memory configuration reference](/reference/memory-config) for supported
formats and limitations.

## Automatic memory flush

When a session is close to auto-compaction, OpenClaw runs a **silent turn** that
reminds the model to write durable notes before the context is summarized. This
prevents important information from being lost during compaction.

Controlled by `agents.defaults.compaction.memoryFlush`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        memoryFlush: {
          enabled: true, // default
          softThresholdTokens: 4000, // how far below compaction threshold to trigger
        },
      },
    },
  },
}
```

Details:

- **Triggers** when context usage crosses
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Runs silently** -- prompts include `NO_REPLY` so nothing is delivered to the
  user.
- **Once per compaction cycle** (tracked in `sessions.json`).
- **Skipped** when the workspace is read-only (`workspaceAccess: "ro"` or
  `"none"`).
- The active memory plugin owns the flush prompt and path policy. The default
  `memory-core` plugin writes to `memory/YYYY-MM-DD.md`.

For the full compaction lifecycle, see [Compaction](/concepts/compaction).

## CLI commands

| Command                          | Description                                |
| -------------------------------- | ------------------------------------------ |
| `openclaw memory status`         | Show memory index status and provider info |
| `openclaw memory search <query>` | Search memory from the command line        |
| `openclaw memory index`          | Force a reindex of memory files            |

Add `--agent <id>` to target a specific agent, `--deep` for extended
diagnostics, or `--json` for machine-readable output.

See [CLI: memory](/cli/memory) for the full command reference.

## Further reading

- [Memory Search](/concepts/memory-search) -- how search works, hybrid search,
  MMR, temporal decay
- [Memory configuration reference](/reference/memory-config) -- all config knobs
  for providers, QMD, hybrid search, batch indexing, and multimodal
- [Compaction](/concepts/compaction) -- how compaction interacts with memory
  flush
- [Session Management Deep Dive](/reference/session-management-compaction) --
  internal session and compaction lifecycle
