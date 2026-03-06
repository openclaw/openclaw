# PR: feat(agents): local model fallback + semantic cache store

## What this PR does

Two new reliability/performance features wired end-to-end into the agent run path:

### 1. Local Model Fallback (`src/agents/local-model-fallback.ts`)

When a cloud API call (Anthropic, etc.) fails with a retriable error — HTTP 429 (rate limit), 500, 502, 503, or a timeout — the system automatically re-runs the same request against a locally-running model via **Ollama** or **LM Studio**. The local model health is checked first (with caching so you don't hammer it); if it's unreachable the original error is re-raised as before.

Config (in your `openclaw.yaml`):

```yaml
agents:
  defaults:
    localModelFallback:
      enabled: true
      provider: ollama # or "lmstudio"
      model: llama3.2
      baseUrl: http://127.0.0.1:11434 # optional, this is the default
      timeoutMs: 60000
      healthCheckIntervalMs: 30000
```

### 2. Semantic Cache Store (`src/agents/semantic-cache-store.ts`)

Before every LLM call, the incoming query is embedded and compared (cosine similarity) against a SQLite-backed store of previous question→answer pairs. If a semantically similar query was seen before (similarity >= threshold, default 0.85), the cached answer is returned immediately — zero API cost, near-zero latency. Successful responses are stored back into the cache automatically.

- Storage: SQLite file at `~/.openclaw/cache/semantic-cache.sqlite`; falls back to in-memory if SQLite is unavailable
- Eviction: TTL-based expiry (default 7 days) + LRU eviction when `maxEntries` is reached (removes oldest 10%)
- Embedding: Ollama's `nomic-embed-text` model by default; pluggable via `embeddingProvider`

Config:

```yaml
agents:
  defaults:
    semanticCache:
      enabled: true
      similarityThreshold: 0.85
      maxEntries: 10000
      ttlMs: 604800000 # 7 days in ms
      embeddingProvider: ollama
      embeddingModel: nomic-embed-text
```

---

## How it's wired

Both features are integrated at the agent runner level (`src/auto-reply/reply/agent-runner-execution.ts`):

1. On each agent run, check semantic cache — if hit, return cached response (skips LLM entirely)
2. If miss, run `runWithLocalModelFallback` instead of `runWithModelFallback`
3. On success, store the response in the semantic cache for future queries

---

## Files changed

| File                                             | Change                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `src/agents/local-model-fallback.ts`             | New — fallback layer with health checks                                                                          |
| `src/agents/semantic-cache-store.ts`             | New — SQLite cache with embedding similarity search                                                              |
| `src/agents/index.ts`                            | New — re-exports both modules                                                                                    |
| `src/agents/model-fallback.ts`                   | Export 3 previously-internal types (`ModelFallbackRunFn`, `ModelFallbackErrorHandler`, `ModelFallbackRunResult`) |
| `src/config/types.agent-defaults.ts`             | Add `localModelFallback` and `semanticCache` to `AgentDefaultsConfig`                                            |
| `src/config/zod-schema.agent-defaults.ts`        | Add Zod schemas for both new config blocks                                                                       |
| `src/auto-reply/reply/agent-runner-execution.ts` | Wire both features into the run path                                                                             |

---

## Tests

5 test files, 47 tests, all passing:

| File                             | What it covers                                                           |
| -------------------------------- | ------------------------------------------------------------------------ |
| `local-model-fallback.test.ts`   | Config resolution, health trigger conditions, cosine similarity          |
| `semantic-cache-store.test.ts`   | Store init, stats, clear, factory function                               |
| `e2e-integration.test.ts`        | 429 detection → fallback trigger → cache config                          |
| `e2e-verification.test.ts`       | Store/search flow with mock embedding provider (no live Ollama required) |
| `final-e2e-verification.test.ts` | End-to-end flow documentation + export verification                      |

All tests run without any live services — Ollama and LM Studio are not required in CI.

---

## Checklist

- [x] `pnpm test` — 47/47 pass
- [x] `pnpm tsgo` — 0 TypeScript errors
- [x] `pnpm check` — lint + format + all custom checks pass
- [ ] Tested manually with Ollama running locally
- [ ] Config documented in docs site

---

## Notes for reviewers

- **`better-sqlite3` is optional** — if not installed, the cache silently degrades to in-memory only. No new required dependencies.
- **Embedding requires Ollama** — the semantic cache only activates if `semanticCache.enabled: true` is set in config. No ambient side effects when disabled.
- **Local fallback is conservative** — it only triggers after the full cloud fallback chain is exhausted, and only when the local model health check passes.
- `SemanticCacheStore` accepts an injected `EmbeddingProvider` for testing without a live Ollama instance.

---

## Setup (for manual testing)

### Ollama

```bash
# Install
curl -fsSL https://ollama.com/install.sh | sh

# Pull models
ollama pull llama3.2
ollama pull nomic-embed-text

# Verify
curl http://127.0.0.1:11434/api/tags
```

### LM Studio

Download from https://lmstudio.ai, load a model, and start the local server on port 1234. Set `provider: lmstudio` and `baseUrl: http://127.0.0.1:1234` in config.

---

## Troubleshooting

**Fallback not triggering**

- Confirm `localModelFallback.enabled: true` in config
- Check Ollama is running: `curl http://127.0.0.1:11434/api/tags`
- Check logs — health check failures are logged at `warn` level under the `local-model-fallback` subsystem

**Cache never hitting**

- Similarity threshold may be too high — try lowering to `0.75`
- Verify Ollama's `nomic-embed-text` model is pulled: `ollama pull nomic-embed-text`
- Check the SQLite file exists at `~/.openclaw/cache/semantic-cache.sqlite`

**Cache too aggressive**

- Raise `similarityThreshold` closer to `0.95` for stricter matching
- Lower `ttlMs` to expire entries sooner
- Reduce `maxEntries` if memory is a concern
