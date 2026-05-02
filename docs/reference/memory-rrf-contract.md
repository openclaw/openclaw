# Memory RRF Contract

## Scope

Task 3 is repurposed from embedding-host rollout to retrieval fusion quality.
Embedding transport remains OpenAI-compatible `/v1/embeddings`; fusion changes stay backend-agnostic.

## Inputs

- Vector candidates from semantic retrieval (`id`, `path`, `startLine`, `endLine`, `score`).
- Lexical candidates from FTS retrieval (`id`, `path`, `startLine`, `endLine`, `score`).
- Hybrid config:
  - `agents.defaults.memorySearch.query.hybrid.enabled`
  - `agents.defaults.memorySearch.query.hybrid.fusion` (`weighted` or `rrf`)
  - `agents.defaults.memorySearch.query.hybrid.vectorWeight`
  - `agents.defaults.memorySearch.query.hybrid.textWeight`
  - existing `mmr` and `temporalDecay` options.

## Fusion Rules

- `weighted`: existing score blend `vectorWeight * vectorScore + textWeight * textScore`.
- `rrf`: reciprocal-rank fusion with weighted ranks:
  - `score = vectorWeight/(k + rankVector) + textWeight/(k + rankText)`
  - `k = 60` (fixed constant for deterministic behavior and stable tuning).

## Ordering Guarantees

- Primary sort: descending fused score.
- Tie-breakers: `path`, then `startLine`, then `endLine`, then `source`.
- This makes ranking deterministic under identical inputs.

## Acceptance Metrics

- Relevance: RRF must improve or match baseline top-k recall on the fixed query set.
- Latency: no meaningful regression against pre-RRF baseline under same corpus size.
- Stability: no provider-resolution regressions and no nondeterministic tie ordering.
