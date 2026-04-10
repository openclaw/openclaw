# Dali Local v1

First concrete substrate for the Dali-local-v1 plan.

This slice intentionally starts small but real:

- append-only SQLite schema for canonical event and audit storage
- bootstrap script to create the local workspace directories and database
- lightweight Python helpers for initializing the store and appending smoke-test events
- practical CLI for appending events/reflections/promotions, semantic indexing, and searching via Qdrant integration.

## Quick start

```bash
# one-shot bootstrap
python3 dali-local-v1/scripts/dali_bootstrap.py
python3 dali-local-v1/scripts/dali_bootstrap.py --seed-smoke-event

# richer local-v1 operations
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 bootstrap --seed-smoke-event
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 append-event --type manual_check --source dali --payload '{"ok":true}'
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 append-reflection --text "Pilot reflection" --source-event-id "<event-id>"
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 append-promotion --reflection-id "<reflection-id>" --claim "Promoted claim" --promoted-to "candidate_memory" --decision "accept" --evidence '{"coherence": 0.9}'
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 list-promotions
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 append-shadow-run --teacher '{"id":"teacher-id"}' --candidates '[{"id":"a"}]' --scores '{"a":0.91}'
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 list-shadow-runs
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 append-eval-run --suite baseline-v1 --target-kind checkpoint --target-id "<checkpoint-id>" --score-summary '{"overall": 0.82}'
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 list-eval-runs --suite baseline-v1
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 compare-eval-runs --suite baseline-v1 --metric overall
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 gate-checkpoint --checkpoint-id "<checkpoint-id>" --suite baseline-v1 --metric overall
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 append-checkpoint --base-model-id openai-codex/gpt-5.4 --status proposed --lineage '{"source":"smoke"}' --metrics '{"quality":0.1}'
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 list-checkpoints
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 set-checkpoint-status --checkpoint-id "<checkpoint-id>" --status approved
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 append-rollback --from-checkpoint-id "<from-id>" --to-checkpoint-id "<to-id>" --reason "Quality regression"
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 list-rollbacks
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 append-nca-snapshot --checkpoint-id "<checkpoint-id>" --motif-summary "motif drift stable" --drift-signal 0.11 --anomaly-flags '["none"]'
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 list-nca-snapshots --checkpoint-id "<checkpoint-id>"
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 append-adapter --base-model-id openai-codex/gpt-5.4 --adapter-path /tmp/adapter.bin --deployment-state deployed --merge-state merged
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 list-adapters --base-model-id openai-codex/gpt-5.4
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 append-compaction-experiment --model-id openai-codex/gpt-5.4 --curriculum-stage 2 --approach segmented_cot_mementos --name memento-pilot --kv-reduction 2.4 --throughput-mult 1.9 --accuracy-delta -0.01
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 append-compaction-experiment --model-id openai-codex/gpt-5.4 --curriculum-stage 3 --approach native_block_masking --name stage-3-check --status completed --leakage-risk 0.14 --max-stage3-leakage-risk 0.2
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 append-compaction-block --experiment-id "<experiment-id>" --segment-index 1 --curriculum-stage 2 --segment "short segment text" --memento "segment summary" --prompt "What changed?" --expected-answer "summary-only is weaker than masked blocks" --side-channel
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 list-compaction-experiments
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 list-compaction-blocks --experiment-id "<experiment-id>"
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 status-snapshot
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 audit-retention --days 30
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 migration-report
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 index-reflections --qdrant-url http://localhost:6333 --collection dali_local_v1_reflections --limit 200
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 search-reflections --query "what was learned" --qdrant-url http://localhost:6333
python3 dali-local-v1/scripts/dali_store.py --root dali-local-v1 summary

Optional dependency note:
- Install Qdrant SDK when you want real semantic search: `pip install qdrant-client`
- Without it, `index-reflections --dry-run` and bootstrap/event workflows still work.
```

By default this creates `dali-local-v1/state/dali.sqlite3` and prints a JSON summary of initialized or appended records.

## Why this exists

`dali-local-v1-spec.md` already defined the architecture. This directory is the first actual implementation artifact, adding a usable append/read/report layer for operator-visible continuity records.

For the compaction-learning slice, see:

- `dali-local-v1/design-notes/compaction-learning-design-note.md`
