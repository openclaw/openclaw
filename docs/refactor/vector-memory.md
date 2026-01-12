---
summary: "Vector memory search design plan (per-agent, watch/lazy sync, storage)"
read_when:
  - Designing or implementing vector memory search
  - Adding embedding providers or sync behavior
---

# Vector Memory Search — Design Plan

Goal: semantic search over **agent memory files** only, with minimal deps and
good UX defaults. Default enabled. Per-agent overrides.

## Scope
- Sources: `MEMORY.md` + `memory/YYYY-MM-DD.md` inside the agent workspace.
- No indexing outside the workspace. No hidden paths.
- No QMD-style query expansion or rerank in v1.

## Config Shape
Location: `agents.defaults.memorySearch` + `agents.list[].memorySearch`.

```json5
agents: {
  defaults: {
    memorySearch: {
      enabled: true,
      provider: "openai", // "openai" | "local"
      fallback: "openai", // "openai" | "none"
      model: "text-embedding-3-small",
      store: {
        driver: "sqlite",
        path: "~/.clawdbot/memory/{agentId}.sqlite"
      },
      chunking: {
        tokens: 400,
        overlap: 80
      },
      sync: {
        onSessionStart: true,
        onSearch: true,        // LazySync
        watch: true,           // default on
        watchDebounceMs: 1500,
        intervalMinutes: 0
      },
      query: {
        maxResults: 6,
        minScore: 0.35
      }
    }
  },
  list: [
    { id: "peter", memorySearch: { provider: "local", sync: { watch: false } } }
  ]
}
```

## Storage
Per-agent DB (default): `~/.clawdbot/memory/{agentId}.sqlite`.

Tables (v1):
- `files(path PRIMARY KEY, hash, mtime, size)`
- `chunks(id PRIMARY KEY, path, start_line, end_line, hash, text, embedding, updated_at)`

Notes:
- `hash` = content hash of chunk text.
- `embedding` stored as float[] (sqlite vec extension optional); if not using vec,
  store as JSON and do linear scan in memory for small corpora.

## Embedding Providers
Interface (core):
- `embedQuery(text): number[]`
- `embedBatch(texts[]): number[][]`

Providers:
- `openai` (default): OpenAI embeddings via existing keys.
- `local` (optional): node-llama-cpp (GGUF).
- Fallback: when `provider: "local"` fails, fallback to OpenAI unless `fallback: "none"`.

## Index Pipeline
1) Resolve memory file list (workspace only).
2) Read file, compute file hash/mtime.
3) Chunk by headings + token cap (overlap).
4) Embed only changed chunks (hash compare).
5) Upsert `chunks` rows, prune deleted files.

Chunking:
- Prefer heading-aware splits.
- Max tokens + overlap; keep line ranges for snippets.

## Sync Strategy
Default: **watch + lazy + session-start**
- `watch`: chokidar on `MEMORY.md` + `memory/**/*.md` (debounced).
- `onSearch`: if dirty, sync before search (LazySync).
- `onSessionStart`: warm index once per session.
- `intervalMinutes`: optional for long-lived sessions.

If workspace access is read-only or missing: disable writes; return “not indexed”.

## Query Flow
1) Embed query.
2) Cosine similarity over all chunk embeddings.
3) Return top K with `{path, startLine, endLine, snippet, score}`.
4) Model may call `memory_get` when full context needed.

Optional v2: add FTS5 + RRF merge (FTS + vector) for quality.

## Tool + CLI
Tools:
- `memory_search { query, maxResults?, minScore? }`
- `memory_get { path, from?, lines? }`

CLI (optional):
- `clawdbot memory index|search|status`

## Security + Permissions
- Indexer reads only memory files in workspace.
- No scanning outside workspace; no “sneak” reads.
- Respect sandbox `workspaceAccess` (ro = read-only; none = disabled).

## Tests
- Chunking boundaries + line ranges.
- Hash-based incremental updates.
- Search ranking (cosine).
- Watcher debounce (fake fs).

## Rollout
- Default enabled; if no memory files, index is empty (silent).
- No migration needed.
