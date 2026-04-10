---
children_hash: 5be3c31f0f8aec7ca567bc74eb5a266e0104a4d5d9ea52baa13a4d2cdd2bbe91
compression_ratio: 0.6703703703703704
condensation_order: 3
covers: [project/_index.md]
covers_token_total: 540
summary_level: d3
token_count: 362
type: summary
---

# project/operations Summary

The **operations** domain covers OpenClaw's cron pipeline architecture and maintenance.

## Core Architecture

9 active cron jobs: 3 collectors (300s timeout) + 6 agents (1800s timeout). Data exchange via `/tmp/openclaw-pipeline/{am,pm,tomorrow.json}`. Model: `openai-codex/gpt-5.4-mini` via ChatGPT Pro OAuth with `minimax/minimax-m2.7` fallback. Achieved ~40% token reduction (5000 → ~2400 tokens/day).

## Refactor Status

- **Phase 1**: Complete — atomic wipe-before-write, per-source error handling
- **Phase 2**: Complete — morning pipeline with `lightContext`
- **Phase 3**: In progress — Knowledge Processor + Evening Analyst
- **Phases 3.5–6**: Pending

## Critical Rules

Zero JSON files in `am/`/`pm/` triggers Telegram alert + EXIT. `tomorrow.json` expires after 36h. Data older than 2h flagged stale. Git push failures log and continue. Use explicit model ID `openai-codex/gpt-5.4-mini`.

## Health Audit (2026-04-08)

Remediation complete: model routing fixed (`openrouter/` prefix), compaction threshold (4000→80000), 4 cron targets corrected, `acpx 0.5.1` installed, `moltbot.json` archived, brv switched to `minimax/minimax-m2.7`.

## Drill-Down

- `project/operations/cron_pipeline_collector_agent_architecture` — Core architecture details
- `project/operations/cron_pipeline_collector_agent_refactor` — Phase 1 validation/execution
- `project/operations/health_audit_2026_04_08` — Remediation details
