---
title: "Memory configuration reference"
summary: "All configuration knobs for memory search, embedding providers, QMD, hybrid search, and multimodal indexing"
read_when:
  - You want to configure memory search providers or embedding models
  - You want to set up the QMD backend
  - You want to tune hybrid search, MMR, or temporal decay
  - You want to enable multimodal memory indexing
---

# Memory configuration reference

This page lists every configuration knob for OpenClaw memory search. For
conceptual overviews, see:

- [Memory Overview](/concepts/memory) -- how memory works
- [Builtin Engine](/concepts/memory-builtin) -- default SQLite backend
- [QMD Engine](/concepts/memory-qmd) -- local-first sidecar
- [Memory Search](/concepts/memory-search) -- search pipeline and tuning

All memory search settings live under `agents.defaults.memorySearch` in
`openclaw.json` unless noted otherwise.

---

## Provider selection

| Key        | Type      | Default          | Description                                                                      |
| ---------- | --------- | ---------------- | -------------------------------------------------------------------------------- |
| `provider` | `string`  | auto-detected    | Embedding adapter ID: `openai`, `gemini`, `voyage`, `mistral`, `ollama`, `local` |
| `model`    | `string`  | provider default | Embedding model name                                                             |
| `fallback` | `string`  | `"none"`         | Fallback adapter ID when the primary fails                                       |
| `enabled`  | `boolean` | `true`           | Enable or disable memory search                                                  |

### Auto-detection order

When `provider` is not set, OpenClaw selects the first available:

1. `local` -- if `memorySearch.local.modelPath` is configured and the file exists.
2. `openai` -- if an OpenAI key can be resolved.
3. `gemini` -- if a Gemini key can be resolved.
4. `voyage` -- if a Voyage key can be resolved.
5. `mistral` -- if a Mistral key can be resolved.

`ollama` is supported but not auto-detected (set it explicitly).

### API key resolution

Remote embeddings require an API key. OpenClaw resolves from:
auth profiles, `models.providers.*.apiKey`, or environment variables.

| Provider | Env var                        | Config key                        |
| -------- | ------------------------------ | --------------------------------- |
| OpenAI   | `OPENAI_API_KEY`               | `models.providers.openai.apiKey`  |
| Gemini   | `GEMINI_API_KEY`               | `models.providers.google.apiKey`  |
| Voyage   | `VOYAGE_API_KEY`               | `models.providers.voyage.apiKey`  |
| Mistral  | `MISTRAL_API_KEY`              | `models.providers.mistral.apiKey` |
| Ollama   | `OLLAMA_API_KEY` (placeholder) | --                                |

Codex OAuth covers chat/completions only and does not satisfy embedding
requests.

---

## Remote endpoint config

For custom OpenAI-compatible endpoints or overriding provider defaults:

| Key              | Type     | Description                                        |
| ---------------- | -------- | -------------------------------------------------- |
| `remote.baseUrl` | `string` | Custom API base URL                                |
| `remote.apiKey`  | `string` | Override API key                                   |
| `remote.headers` | `object` | Extra HTTP headers (merged with provider defaults) |

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "openai",
        model: "text-embedding-3-small",
        remote: {
          baseUrl: "https://api.example.com/v1/",
          apiKey: "YOUR_KEY",
        },
      },
    },
  },
}
```

---

## Gemini-specific config

| Key                    | Type     | Default                | Description                                |
| ---------------------- | -------- | ---------------------- | ------------------------------------------ |
| `model`                | `string` | `gemini-embedding-001` | Also supports `gemini-embedding-2-preview` |
| `outputDimensionality` | `number` | `3072`                 | For Embedding 2: 768, 1536, or 3072        |

<Warning>
Changing model or `outputDimensionality` triggers an automatic full reindex.
</Warning>

---

## Local embedding config

| Key                   | Type     | Default                | Description                     |
| --------------------- | -------- | ---------------------- | ------------------------------- |
| `local.modelPath`     | `string` | auto-downloaded        | Path to GGUF model file         |
| `local.modelCacheDir` | `string` | node-llama-cpp default | Cache dir for downloaded models |

Default model: `embeddinggemma-300m-qat-Q8_0.gguf` (~0.6 GB, auto-downloaded).
Requires native build: `pnpm approve-builds` then `pnpm rebuild node-llama-cpp`.

---

## Hybrid search config

All under `memorySearch.query.hybrid`:

| Key                   | Type      | Default | Description                        |
| --------------------- | --------- | ------- | ---------------------------------- |
| `enabled`             | `boolean` | `true`  | Enable hybrid BM25 + vector search |
| `vectorWeight`        | `number`  | `0.7`   | Weight for vector scores (0-1)     |
| `textWeight`          | `number`  | `0.3`   | Weight for BM25 scores (0-1)       |
| `candidateMultiplier` | `number`  | `4`     | Candidate pool size multiplier     |

### MMR (diversity)

| Key           | Type      | Default | Description                          |
| ------------- | --------- | ------- | ------------------------------------ |
| `mmr.enabled` | `boolean` | `false` | Enable MMR re-ranking                |
| `mmr.lambda`  | `number`  | `0.7`   | 0 = max diversity, 1 = max relevance |

### Temporal decay (recency)

| Key                          | Type      | Default | Description               |
| ---------------------------- | --------- | ------- | ------------------------- |
| `temporalDecay.enabled`      | `boolean` | `false` | Enable recency boost      |
| `temporalDecay.halfLifeDays` | `number`  | `30`    | Score halves every N days |

Evergreen files (`MEMORY.md`, non-dated files in `memory/`) are never decayed.

### Full example

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        query: {
          hybrid: {
            vectorWeight: 0.7,
            textWeight: 0.3,
            mmr: { enabled: true, lambda: 0.7 },
            temporalDecay: { enabled: true, halfLifeDays: 30 },
          },
        },
      },
    },
  },
}
```

---

## Additional memory paths

| Key          | Type       | Description                              |
| ------------ | ---------- | ---------------------------------------- |
| `extraPaths` | `string[]` | Additional directories or files to index |

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        extraPaths: ["../team-docs", "/srv/shared-notes"],
      },
    },
  },
}
```

Paths can be absolute or workspace-relative. Directories are scanned
recursively for `.md` files. Symlink handling depends on the active backend:
the builtin engine ignores symlinks, while QMD follows the underlying QMD
scanner behavior.

For agent-scoped cross-agent transcript search, use
`agents.list[].memorySearch.qmd.extraCollections` instead of `memory.qmd.paths`.
Those extra collections follow the same `{ path, name, pattern? }` shape, but
they are merged per agent and can preserve explicit shared names when the path
points outside the current workspace.
If the same resolved path appears in both `memory.qmd.paths` and
`memorySearch.qmd.extraCollections`, QMD keeps the first entry and skips the
duplicate.

---

## Multimodal memory (Gemini)

Index images and audio alongside Markdown using Gemini Embedding 2:

| Key                       | Type       | Default    | Description                            |
| ------------------------- | ---------- | ---------- | -------------------------------------- |
| `multimodal.enabled`      | `boolean`  | `false`    | Enable multimodal indexing             |
| `multimodal.modalities`   | `string[]` | --         | `["image"]`, `["audio"]`, or `["all"]` |
| `multimodal.maxFileBytes` | `number`   | `10000000` | Max file size for indexing             |

Only applies to files in `extraPaths`. Default memory roots stay Markdown-only.
Requires `gemini-embedding-2-preview`. `fallback` must be `"none"`.

Supported formats: `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.heic`, `.heif`
(images); `.mp3`, `.wav`, `.ogg`, `.opus`, `.m4a`, `.aac`, `.flac` (audio).

---

## Embedding cache

| Key                | Type      | Default | Description                      |
| ------------------ | --------- | ------- | -------------------------------- |
| `cache.enabled`    | `boolean` | `false` | Cache chunk embeddings in SQLite |
| `cache.maxEntries` | `number`  | `50000` | Max cached embeddings            |

Prevents re-embedding unchanged text during reindex or transcript updates.

---

## Batch indexing

| Key                           | Type      | Default | Description                |
| ----------------------------- | --------- | ------- | -------------------------- |
| `remote.batch.enabled`        | `boolean` | `false` | Enable batch embedding API |
| `remote.batch.concurrency`    | `number`  | `2`     | Parallel batch jobs        |
| `remote.batch.wait`           | `boolean` | `true`  | Wait for batch completion  |
| `remote.batch.pollIntervalMs` | `number`  | --      | Poll interval              |
| `remote.batch.timeoutMinutes` | `number`  | --      | Batch timeout              |

Available for `openai`, `gemini`, and `voyage`. OpenAI batch is typically
fastest and cheapest for large backfills.

---

## Session memory search (experimental)

Index session transcripts and surface them via `memory_search`:

| Key                           | Type       | Default      | Description                             |
| ----------------------------- | ---------- | ------------ | --------------------------------------- |
| `experimental.sessionMemory`  | `boolean`  | `false`      | Enable session indexing                 |
| `sources`                     | `string[]` | `["memory"]` | Add `"sessions"` to include transcripts |
| `sync.sessions.deltaBytes`    | `number`   | `100000`     | Byte threshold for reindex              |
| `sync.sessions.deltaMessages` | `number`   | `50`         | Message threshold for reindex           |

Session indexing is opt-in and runs asynchronously. Results can be slightly
stale. Session logs live on disk, so treat filesystem access as the trust
boundary.

---

## SQLite vector acceleration (sqlite-vec)

| Key                          | Type      | Default | Description                       |
| ---------------------------- | --------- | ------- | --------------------------------- |
| `store.vector.enabled`       | `boolean` | `true`  | Use sqlite-vec for vector queries |
| `store.vector.extensionPath` | `string`  | bundled | Override sqlite-vec path          |

When sqlite-vec is unavailable, OpenClaw falls back to in-process cosine
similarity automatically.

---

## Index storage

| Key                   | Type     | Default                               | Description                                 |
| --------------------- | -------- | ------------------------------------- | ------------------------------------------- |
| `store.path`          | `string` | `~/.openclaw/memory/{agentId}.sqlite` | Index location (supports `{agentId}` token) |
| `store.fts.tokenizer` | `string` | `unicode61`                           | FTS5 tokenizer (`unicode61` or `trigram`)   |

---

## QMD backend config

Set `memory.backend = "qmd"` to enable. All QMD settings live under
`memory.qmd`:

| Key                      | Type      | Default  | Description                                  |
| ------------------------ | --------- | -------- | -------------------------------------------- |
| `command`                | `string`  | `qmd`    | QMD executable path                          |
| `searchMode`             | `string`  | `search` | Search command: `search`, `vsearch`, `query` |
| `includeDefaultMemory`   | `boolean` | `true`   | Auto-index `MEMORY.md` + `memory/**/*.md`    |
| `paths[]`                | `array`   | --       | Extra paths: `{ name, path, pattern? }`      |
| `sessions.enabled`       | `boolean` | `false`  | Index session transcripts                    |
| `sessions.retentionDays` | `number`  | --       | Transcript retention                         |
| `sessions.exportDir`     | `string`  | --       | Export directory                             |

### Update schedule

| Key                       | Type      | Default | Description                           |
| ------------------------- | --------- | ------- | ------------------------------------- |
| `update.interval`         | `string`  | `5m`    | Refresh interval                      |
| `update.debounceMs`       | `number`  | `15000` | Debounce file changes                 |
| `update.onBoot`           | `boolean` | `true`  | Refresh on startup                    |
| `update.waitForBootSync`  | `boolean` | `false` | Block startup until refresh completes |
| `update.embedInterval`    | `string`  | --      | Separate embed cadence                |
| `update.commandTimeoutMs` | `number`  | --      | Timeout for QMD commands              |
| `update.updateTimeoutMs`  | `number`  | --      | Timeout for QMD update operations     |
| `update.embedTimeoutMs`   | `number`  | --      | Timeout for QMD embed operations      |

### Limits

| Key                       | Type     | Default | Description                |
| ------------------------- | -------- | ------- | -------------------------- |
| `limits.maxResults`       | `number` | `6`     | Max search results         |
| `limits.maxSnippetChars`  | `number` | --      | Clamp snippet length       |
| `limits.maxInjectedChars` | `number` | --      | Clamp total injected chars |
| `limits.timeoutMs`        | `number` | `4000`  | Search timeout             |

### Scope

Controls which sessions can receive QMD search results. Same schema as
[`session.sendPolicy`](/gateway/configuration-reference#session):

```json5
{
  memory: {
    qmd: {
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { chatType: "direct" } }],
      },
    },
  },
}
```

Default is DM-only. `match.keyPrefix` matches the normalized session key;
`match.rawKeyPrefix` matches the raw key including `agent:<id>:`.

### Citations

`memory.citations` applies to all backends:

| Value            | Behavior                                            |
| ---------------- | --------------------------------------------------- |
| `auto` (default) | Include `Source: <path#line>` footer in snippets    |
| `on`             | Always include footer                               |
| `off`            | Omit footer (path still passed to agent internally) |

### Full QMD example

```json5
{
  memory: {
    backend: "qmd",
    citations: "auto",
    qmd: {
      includeDefaultMemory: true,
      update: { interval: "5m", debounceMs: 15000 },
      limits: { maxResults: 6, timeoutMs: 4000 },
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { chatType: "direct" } }],
      },
      paths: [{ name: "docs", path: "~/notes", pattern: "**/*.md" }],
    },
  },
}
```

---

## Dreaming (experimental)

Dreaming is configured under `plugins.entries.memory-core.config.dreaming`,
not under `agents.defaults.memorySearch`. Dreaming uses three cooperative
phases (light, deep, REM), each with its own schedule and config. For
conceptual details and chat commands, see [Dreaming](/concepts/dreaming).

### Global settings

| Key                       | Type      | Default    | Description                                                  |
| ------------------------- | --------- | ---------- | ------------------------------------------------------------ |
| `enabled`                 | `boolean` | `true`     | Master switch for all phases                                 |
| `timezone`                | `string`  | unset      | Timezone for schedule evaluation and dreaming date bucketing |
| `verboseLogging`          | `boolean` | `false`    | Emit detailed per-run dreaming logs                          |
| `storage.mode`            | `string`  | `"inline"` | Inline `dreams.md`, separate reports, or both                |
| `storage.separateReports` | `boolean` | `false`    | Write separate report files per phase                        |

### Light phase (`phases.light`)

Scans recent traces, dedupes, and stages candidates into `dreams.md` when
inline storage is enabled.
Does **not** write to `MEMORY.md`.

| Key                | Type       | Default                         | Description                 |
| ------------------ | ---------- | ------------------------------- | --------------------------- |
| `enabled`          | `boolean`  | `true`                          | Enable light phase          |
| `cron`             | `string`   | `0 */6 * * *`                   | Schedule (every 6 hours)    |
| `lookbackDays`     | `number`   | `2`                             | Days of traces to scan      |
| `limit`            | `number`   | `100`                           | Max candidates to stage     |
| `dedupeSimilarity` | `number`   | `0.9`                           | Jaccard threshold for dedup |
| `sources`          | `string[]` | `["daily","sessions","recall"]` | Data sources                |

### Deep phase (`phases.deep`)

Promotes qualified candidates into `MEMORY.md`. The **only** phase that
writes durable facts. Also owns recovery when memory is thin.

| Key                   | Type       | Default                                         | Description                          |
| --------------------- | ---------- | ----------------------------------------------- | ------------------------------------ |
| `enabled`             | `boolean`  | `true`                                          | Enable deep phase                    |
| `cron`                | `string`   | `0 3 * * *`                                     | Schedule (daily at 3 AM)             |
| `limit`               | `number`   | `10`                                            | Max candidates to promote per cycle  |
| `minScore`            | `number`   | `0.8`                                           | Minimum weighted score for promotion |
| `minRecallCount`      | `number`   | `3`                                             | Minimum recall count threshold       |
| `minUniqueQueries`    | `number`   | `3`                                             | Minimum distinct query count         |
| `recencyHalfLifeDays` | `number`   | `14`                                            | Days for recency score to halve      |
| `maxAgeDays`          | `number`   | `30`                                            | Max daily-note age for promotion     |
| `sources`             | `string[]` | `["daily","memory","sessions","logs","recall"]` | Data sources                         |

#### Deep recovery (`phases.deep.recovery`)

| Key                      | Type      | Default | Description                                |
| ------------------------ | --------- | ------- | ------------------------------------------ |
| `enabled`                | `boolean` | `true`  | Enable automatic recovery                  |
| `triggerBelowHealth`     | `number`  | `0.35`  | Health score threshold to trigger recovery |
| `lookbackDays`           | `number`  | `30`    | How far back to look for recovery material |
| `maxRecoveredCandidates` | `number`  | `20`    | Max candidates to recover per run          |
| `minRecoveryConfidence`  | `number`  | `0.9`   | Minimum confidence for recovery candidates |
| `autoWriteMinConfidence` | `number`  | `0.97`  | Auto-write threshold (skip manual review)  |

### REM phase (`phases.rem`)

Writes themes, reflections, and pattern notes into `dreams.md` when inline
storage is enabled.
Does **not** write to `MEMORY.md`.

| Key                  | Type       | Default                     | Description                        |
| -------------------- | ---------- | --------------------------- | ---------------------------------- |
| `enabled`            | `boolean`  | `true`                      | Enable REM phase                   |
| `cron`               | `string`   | `0 5 * * 0`                 | Schedule (weekly, Sunday 5 AM)     |
| `lookbackDays`       | `number`   | `7`                         | Days of material to reflect on     |
| `limit`              | `number`   | `10`                        | Max patterns or themes to write    |
| `minPatternStrength` | `number`   | `0.75`                      | Minimum tag co-occurrence strength |
| `sources`            | `string[]` | `["memory","daily","deep"]` | Data sources for reflection        |

### Execution overrides

Each phase accepts an `execution` block. There is also a global
`execution.defaults` block that phases inherit from.

| Key               | Type     | Default      | Description                    |
| ----------------- | -------- | ------------ | ------------------------------ |
| `speed`           | `string` | `"balanced"` | `fast`, `balanced`, or `slow`  |
| `thinking`        | `string` | `"medium"`   | `low`, `medium`, or `high`     |
| `budget`          | `string` | `"medium"`   | `cheap`, `medium`, `expensive` |
| `model`           | `string` | unset        | Override model for this phase  |
| `maxOutputTokens` | `number` | unset        | Cap output tokens              |
| `temperature`     | `number` | unset        | Sampling temperature (0-2)     |
| `timeoutMs`       | `number` | unset        | Phase timeout in milliseconds  |

### Example

```json5
{
  plugins: {
    entries: {
      "memory-core": {
        config: {
          dreaming: {
            enabled: true,
            timezone: "America/New_York",
            phases: {
              light: { cron: "0 */4 * * *", lookbackDays: 3 },
              deep: { minScore: 0.85, recencyHalfLifeDays: 21 },
              rem: { lookbackDays: 14 },
            },
          },
        },
      },
    },
  },
}
```
