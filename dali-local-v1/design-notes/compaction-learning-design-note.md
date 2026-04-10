# Compaction-as-Skill Design Note (Dali local-v1)

## Core extraction from the paper

- Compaction should be treated as a learned behavior, not only a runtime post-processor.
- Use **segmented CoT + mementos** so the model practices restoring state with bounded reminders instead of full-history replay.
- A **3-stage curriculum** is the practical path:
  1. baseline utility recovery on context-compression tasks (summary-only controls),
  2. segmented prompting with explicit mementos,
  3. native block-masking style behavior and policy tuning.
- Observed in the source paper: roughly **~2–3x KV reduction** and **~2x throughput gain**, with small accuracy deltas.
- Important caveat: there can be **implicit KV-side-channel leakage from masked blocks**; keep this in the evaluation gate and do not treat gains as only a semantic win.

## What to implement now (minimal, concrete)

1. Log compaction experiments as first-class training artifacts (not transient chat log notes).
2. Store per-segment memento examples and source cues so the model can be taught recovery behavior stage-by-stage.
3. Keep stage, approach, and leakage-risk scores as explicit fields for gate decisions.
4. Track comparisons (`summary_only` vs `segmented_cot_mementos` vs `native_block_masking`) on the same dataset.

## Current code mapping (implemented)

- `dali-local-v1/sql/schema.sql`
  - Added `compaction_experiments`.
  - Added `compaction_blocks`.
- `dali-local-v1/src/memory_store.py`
  - Added: `append_compaction_experiment`, `append_compaction_block`,
    `list_recent_compaction_experiments`, `list_compaction_blocks_for_experiment`.
- `dali-local-v1/scripts/dali_store.py`
  - Added CLI commands:
    - `append-compaction-experiment`
    - `append-compaction-block`
    - `list-compaction-experiments`
    - `list-compaction-blocks`
- `dali-local-v1/tests/test_memory_store.py`
  - Added tests for experiment/block lifecycle and FK integrity for blocks.
- Migration hardening:
  - `init_db` now creates missing compaction tables on existing DBs.
  - CLI now calls schema application on open DBs for lightweight migration of prior installs.
- Stage-3 gate tightening:
  - Completing a stage-3 experiment requires an explicit leakage-risk score and allows it only below a configured threshold.
  - New CLI flag: `--max-stage3-leakage-risk` on `append-compaction-experiment`.

## Evaluation contract for this slice

- Before marking the feature complete, verify that experiments can be appended and linked blocks are readable by `experiment_id`.
- Explicitly compare approach and stage rows via SQL/CLI when reviewing gains.
- Never finalize stage-3-only rollout unless `leakage_risk_score` is bounded in the gate.

## Suggested gate (next minimal action)

- Run a pilot dataset through all three stages and record:
  - `kv_reduction_ratio`, `throughput_mult`, `accuracy_delta`, `leakage_risk_score`.
- Keep side-channel-sensitive rows tagged; prefer the safer approach until leak-risk is controlled.
