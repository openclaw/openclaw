# Rollout Plan: Bulletproof Local Indexing

## Phase 1: Baseline build (done)

- Build a single pipeline for docs + code + runtime/config docs.
- Redact runtime secrets before indexing.
- Emit deterministic artifacts (`documents.jsonl`, `manifest.json`, `failures.jsonl`).
- Enforce quality gates in strict mode.

## Phase 2: Local production wiring

1. Schedule rebuilds:
   - `hourly` for docs + runtime.
   - `daily` full rebuild with all code roots.
2. Keep two snapshots:
   - `current` (active)
   - `previous` (rollback/comparison)
3. Add alert checks from `manifest.json`:
   - docs page count delta > 10%
   - hidden-doc count changed
   - doc failure rate > threshold
   - runtime file count suddenly zero

## Phase 3: Retrieval integration

1. Load `documents.jsonl` into your local retrieval stack (SQLite FTS, sqlite-vec, or your vector DB).
2. Use metadata filters at query time:
   - `kind in [doc, code, runtime, config-doc]`
   - `locale`
   - `source prefix`
3. Add result blending policy:
   - Prioritize `runtime` + `config-doc` for environment-specific troubleshooting.
   - Use `code` for implementation truth.
   - Use `doc` for official behavior guidance.

## Phase 4: Hardening

1. Add CI check:
   - run `pnpm index:openclaw`
   - fail on quality gate failures.
2. Add smoke verification queries after index build:
   - gateway auth flow
   - configuration reference path
   - known hidden-doc paths
3. Add drift dashboard from `manifest.json` history.

## Phase 5: Governance

- Treat index outputs as sensitive if runtime artifacts are included.
- Store outputs on encrypted disk.
- Restrict access to index files and retrieval service.
- Keep redaction patterns reviewed as new config keys are introduced.

## Brutal reality checkpoint

- Docs manifests are incomplete; link-crawl is mandatory.
- Docs are not equivalent to source code truth.
- Runtime indexing without redaction is a data leak risk.
- "Bulletproof" requires repeated validation, not a one-time crawl.
