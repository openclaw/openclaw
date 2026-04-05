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
not under `agents.defaults.memorySearch`. For conceptual details and chat
commands, see [Dreaming](/concepts/memory-dreaming).

| Key                | Type     | Default        | Description                               |
| ------------------ | -------- | -------------- | ----------------------------------------- |
| `mode`             | `string` | `"off"`        | Preset: `off`, `core`, `rem`, or `deep`   |
| `cron`             | `string` | preset default | Cron expression override for the schedule |
| `timezone`         | `string` | user timezone  | Timezone for schedule evaluation          |
| `limit`            | `number` | preset default | Max candidates to promote per cycle       |
| `minScore`         | `number` | preset default | Minimum weighted score for promotion      |
| `minRecallCount`   | `number` | preset default | Minimum recall count threshold            |
| `minUniqueQueries` | `number` | preset default | Minimum distinct query count threshold    |

### Preset defaults

| Mode   | Cadence        | minScore | minRecallCount | minUniqueQueries |
| ------ | -------------- | -------- | -------------- | ---------------- |
| `off`  | Disabled       | --       | --             | --               |
| `core` | Daily 3 AM     | 0.75     | 3              | 2                |
| `rem`  | Every 6 hours  | 0.85     | 4              | 3                |
| `deep` | Every 12 hours | 0.80     | 3              | 3                |

### Example

```json5
{
  plugins: {
    entries: {
      "memory-core": {
        config: {
          dreaming: {
            mode: "core",
            timezone: "America/New_York",
          },
        },
      },
    },
  },
}
```
