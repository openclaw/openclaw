# Plan: Reranker Plugins for memory-core

## Context Gathered

- MMR lives in `extensions/memory-core/src/memory/mmr.ts`; `tokenize.ts` is a sibling
- `tokenize.ts` is used by BOTH `mmr.ts` AND `dreaming-phases.ts` — can't freely move it
- Single integration point: `hybrid.ts:mergeHybridResults()` calls `applyMMRToHybridResults()`
- Config flows from `src/agents/memory-search.ts:ResolvedMemorySearchConfig.query.hybrid.mmr`
- Plugin pattern: `definePluginEntry` + `register(api)` + `openclaw.plugin.json` manifest
- Embedding provider analogy: `memoryEmbeddingProviders` contract registered via `api.registerMemoryEmbeddingProvider()`
- Model selection: `"provider/model-id"` string, resolved via `models.providers` config
- Bundled plugins ship in core dist; external plugins are user-installed

## Plan: Reranker Plugins (MMR bundled, LLM external)

TL;DR — Extract MMR into a new bundled plugin (`extensions/memory-mmr/`), create an external LLM reranker plugin (`extensions/memory-external-reranker/`). Both implement a new `MemoryRerankerPlugin` SDK contract. `hybrid.ts` receives the resolved reranker via injection rather than importing `mmr.ts` directly. `tokenize.ts` moves to `extensions/memory-mmr/`; `dreaming-phases.ts` gets an inline minimal `textSimilarity` to sever the cross-plugin dependency. Default config leaves behavior unchanged.

**Steps**

### Phase 1: Plugin SDK contract _(blocks all other phases)_

1. New `src/plugin-sdk/memory-core-host-engine-reranker.ts` — define `MemoryRerankerPlugin` interface:
   - `id: string`
   - `rerank(params: RerankParams): Promise<RerankResult>`
   - `RerankParams = { query: string; documents: Array<{ id: string; content: string; score: number }>; limit: number }`
   - `RerankResult = Array<{ id: string; score: number }>`
2. Add `registerMemoryReranker(impl: MemoryRerankerPlugin): void` to plugin registration API (follows same pattern as `registerMemoryEmbeddingProvider`)
3. Add `getRegisteredMemoryReranker(id: string): MemoryRerankerPlugin | undefined` — lookup by id string

### Phase 2: New bundled `extensions/memory-mmr/` plugin _(depends on Phase 1, parallel with Phase 3)_

4. Move `extensions/memory-core/src/memory/mmr.ts` → `extensions/memory-mmr/src/mmr-reranker.ts`
5. Move `extensions/memory-core/src/memory/tokenize.ts` → `extensions/memory-mmr/src/tokenize.ts`
6. Move `extensions/memory-core/src/memory/mmr.test.ts` → `extensions/memory-mmr/src/mmr-reranker.test.ts`
7. In `dreaming-phases.ts` (memory-core): replace `import { textSimilarity } from "./memory/tokenize.js"` with an inline minimal Jaccard similarity helper (the function is small and pure; avoids cross-plugin src import)
8. Delete `extensions/memory-core/src/memory/mmr.ts` and `tokenize.ts` from memory-core
9. Create `extensions/memory-mmr/openclaw.plugin.json`:
   - `id: "memory-mmr"`, `activation.onStartup: false`, bundled
   - `contracts: { "memoryRerankers": ["memory-mmr"] }`
   - No configSchema (MMR config stays in `agents.defaults.memorySearch.query.hybrid.mmr`)
10. Create `extensions/memory-mmr/package.json`, `extensions/memory-mmr/index.ts` — `definePluginEntry` calling `api.registerMemoryReranker(createMMRReranker())`
11. `extensions/memory-mmr/src/mmr-reranker.ts` — wraps `mmrRerank()` algorithm behind the `MemoryRerankerPlugin` interface

### Phase 3: New external `extensions/memory-external-reranker/` plugin _(depends on Phase 1, parallel with Phase 2)_

12. Create `extensions/memory-external-reranker/openclaw.plugin.json`:
    - `id: "memory-external-reranker"`, `activation.onStartup: false`, external
    - `contracts: { "memoryRerankers": ["memory-external-reranker"] }`
    - `configSchema`: flat fields — `model: string` (primary model ID in `"provider/model-id"` form), `modelFallbacks: string[]` (ordered fallback model IDs, default `[]`), `endpointPath: string` (default `"/v1/rerank"`), `topN?: integer` — no `anyOf`/`oneOf`; follows active-memory's `model: string` + `modelFallback: string` pattern, extended to an array for multi-fallback
    - `uiHints` for `model` with placeholder and help text
    - `setup.providers` declaring API key auth source
13. Create `extensions/memory-external-reranker/package.json`, `extensions/memory-external-reranker/index.ts` — `definePluginEntry` registering via `api.registerMemoryReranker(createLLMRerankerProvider())`
14. `extensions/memory-external-reranker/src/reranker-provider.ts` — factory; reads `model` + `modelFallbacks` from `api.pluginConfig`; builds candidate list `[model, ...modelFallbacks]`; iterates candidates in order, collecting `FallbackAttempt[]`, returning on first success; splits each `"provider/model-id"` → looks up `models.providers[provider]` for `baseUrl` + auth; calls Cohere-compatible `POST {baseUrl}{endpointPath}` (default `/v1/rerank`); throws aggregated error with all attempts only after all candidates fail
15. `extensions/memory-external-reranker/src/reranker-provider.runtime.ts` — lazy-loaded HTTP implementation

### Phase 4: Memory-core config + wiring _(depends on Phase 1)_

16. Extend `ResolvedMemorySearchConfig.query.hybrid.mmr` in `src/agents/memory-search.ts`:
    - Add `provider: string` — ID of the registered reranker to use (default `"memory-mmr"`); special sentinel `"none"` disables reranking. Backward compat: when `provider` is absent, derive from existing `enabled` field — `enabled: true` → `provider: "memory-mmr"`, `enabled: false` → `provider: "none"`. Existing `enabled` + `lambda` fields remain unchanged.
    - Add `fallback: string` — fallback reranker ID (default `"none"`); mirrors `memorySearch.fallback` exactly
17. Update resolver defaults in same file (triple-coalesce pattern matching existing `mmr.enabled`/`lambda` resolution)
18. Extend `extensions/memory-core/openclaw.plugin.json` configSchema with `mmr.provider: string` and `mmr.fallback: string` under the `mmr` object
19. Update `hybrid.ts:mergeHybridResults()` — remove `applyMMRToHybridResults` import; add `reranker?: MemoryRerankerPlugin` and `fallbackReranker?: MemoryRerankerPlugin` params; dispatch: if `provider !== "none"` and `reranker` present → call it; on error if `fallbackReranker` present → call it; if `provider === "none"` → skip. Mirrors the string-id selection of the TTS/embedding provider chains.
20. Update `manager.ts` — call `getRegisteredMemoryReranker(hybrid.mmr.provider)` and `getRegisteredMemoryReranker(hybrid.mmr.fallback)`, pass both to `mergeHybridResults()`

### Phase 5: Tests _(depends on Phases 2, 3, 4)_

**5a. Move and update `mmr-reranker.test.ts`** _(depends on Phase 2)_ 21. Move `extensions/memory-core/src/memory/mmr.test.ts` → `extensions/memory-mmr/src/mmr-reranker.test.ts` 22. Update imports: algorithm exports from `"./mmr-reranker.js"`; tokenize exports (`tokenize`, `jaccardSimilarity`, `textSimilarity`) from `"./tokenize.js"` (split since files are now separate). All test suites stay unchanged: `tokenize`, `jaccardSimilarity`, `textSimilarity`, `computeMMRScore`, `mmrRerank`, `applyMMRToHybridResults`.

**5b. New `reranker-provider.test.ts`** — `extensions/memory-external-reranker/src/reranker-provider.test.ts` _(depends on Phase 3)_ 23. Style: `global.fetch = vi.fn()` + `afterEach(() => { global.fetch = priorFetch; vi.unstubAllEnvs(); })` (matching brave tests) 24. Test suites: - **single model** — `model: "llamacpp/qwen3"`, no fallbacks → one fetch to `http://localhost:8080/v1/rerank`; verify body `{ query, documents, top_n }` - **modelFallbacks fallthrough** — first provider non-ok → second fetch fires with second provider's baseUrl - **all-fail aggregation** — both candidates fail → rejects with error mentioning both providers - **endpointPath override** — `endpointPath: "/rerank"` → URL path is `/rerank` - **topN cap** — `topN: 3` with query `limit: 10` → `top_n: 3` in body - **score + ordering** — response `relevance_score` maps to `RerankResult.score`; original document `id` preserved

**5c. Update `hybrid.test.ts`** _(depends on Phase 4)_ 25. Remove imports of `applyMMRToHybridResults` / `./mmr.js` — those tests now live in `mmr-reranker.test.ts` 26. Add injected reranker tests to `mergeHybridResults` suite: - **provider present** → `reranker.rerank()` called; result order matches mock return - **provider `"none"`** → `reranker.rerank()` not called; score order preserved - **reranker throws + fallbackReranker** → fallback called; primary error swallowed - **reranker throws + no fallback** → fail-open; returns score-ordered results (no throw) - Mock: `{ id: "mock", rerank: vi.fn(async ({ documents }) => documents.map((d, i) => ({ id: d.id, score: 1 - i * 0.1 }))) }`

**5d. Contracts check** _(spans all phases)_ 27. `registerMemoryReranker` is a new shared plugin surface → run `pnpm test:contracts:plugins` after Phase 1. No new contract file needed if the pattern mirrors `registerWebSearchProvider` exactly.

**Relevant files**

- `src/agents/memory-search.ts` — extend `ResolvedMemorySearchConfig` + resolver
- `src/plugin-sdk/memory-core-host-engine-reranker.ts` — **new** SDK interface
- `extensions/memory-core/src/memory/mmr.ts` — **moved** to memory-mmr plugin
- `extensions/memory-core/src/memory/tokenize.ts` — **moved** to memory-mmr plugin
- `extensions/memory-core/src/memory/hybrid.ts` — remove mmr import, add reranker params
- `extensions/memory-core/src/memory/manager.ts` — lookup + inject both rerankers
- `extensions/memory-core/src/dreaming-phases.ts` — inline minimal textSimilarity
- `extensions/memory-core/openclaw.plugin.json` — add `mmr.provider`/`mmr.fallback` to schema
- `extensions/memory-mmr/` — **new** bundled plugin (5 files + 1 test file)
- `extensions/memory-external-reranker/` — **new** external plugin (5 files + 1 test file)

**Verification**

1. `pnpm test:extension memory-mmr` — moved algorithm tests pass; split tokenize imports work
2. `pnpm test:extension memory-external-reranker` — mock HTTP tests pass: model/modelFallbacks, endpointPath, topN, score mapping, all-fail aggregation
3. `pnpm test extensions/memory-core/src/memory/hybrid.test.ts` — injected mock; provider/fallback dispatch; `"none"` skips; fail-open
4. `pnpm test:contracts:plugins` — new `registerMemoryReranker` surface passes shared seam smoke checks
5. `pnpm tsgo` — typecheck clean (especially `dreaming-phases.ts` after tokenize removal)
6. `pnpm check` — import boundary scans (`test/extension-import-boundaries.test.ts`) auto-cover both new extensions; no registration needed
7. Manual: default config → `enabled: false` → no reranking; `enabled: true` → bundled MMR as before
8. Manual: `mmr.provider: "memory-external-reranker"` + `plugins.entries.memory-external-reranker.config.model: "llamacpp/qwen3-reranker-4b"` → external call fires
9. Manual: bad API key + `mmr.fallback: "memory-mmr"` → falls back to bundled MMR plugin

**Decisions**

- `tokenize.ts` moves to memory-mmr plugin; `dreaming-phases.ts` gets inline minimal helper (avoids cross-plugin import, smaller than extracting a shared package)
- `provider: string` (default `"memory-mmr"`) follows the `memorySearch.provider`/`memorySearch.fallback` string-ID pattern — no new enum concept; `"none"` is the existing sentinel for "disable", same as `memorySearch.fallback: "none"`
- Backward compat: existing `mmr.enabled: boolean` field is preserved; resolver derives `provider` from it when `provider` is absent — no doctor migration needed for current users
- `model: string` + `modelFallbacks: string[]` in reranker plugin configSchema follows active-memory's `model`/`modelFallback` style and avoids `anyOf`/`oneOf` (AGENTS.md policy: "prefer flat string enum helpers over `Type.Union`")
- MMR plugin is bundled → always registered by id `"memory-mmr"`, always available as fallback value
- External reranker uses Cohere-compatible `POST {baseUrl}{endpointPath}` — works with Cohere, Jina, Voyage AI, llama.cpp `/v1/rerank`
- Auth via existing `models.providers[provider]` — no new auth surface
- `topN` in reranker configSchema lets users cap external API results (default: query `limit`)
