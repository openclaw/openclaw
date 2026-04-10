---
children_hash: aebb8f1c5bd2174994d6e626380bbc428166a9bfe74b1864576f475d799ff5da
compression_ratio: 0.44505494505494503
condensation_order: 1
covers:
  [
    cron_pipeline_collector_agent_architecture.md,
    cron_pipeline_collector_agent_refactor.md,
    health_audit_2026_04_08.md,
  ]
covers_token_total: 1274
summary_level: d1
token_count: 567
type: summary
---

# project/operations

## Overview

Documentation for OpenClaw's cron pipeline architecture and operational tooling. Covers the collector-agent refactor, health audit remediation, and ongoing pipeline improvements.

## Key Topics

**cron_pipeline_collector_agent_architecture** — Core architecture replacing 11 monolithic agent sessions with lightweight collectors feeding specialized agents. 9 active cron jobs (3 collectors @ 300s timeout, 6 agents @ 1800s timeout). Pipeline data exchange via `/tmp/openclaw-pipeline/{am,pm,tomorrow.json}`. Uses `openai-codex/gpt-5.4-mini` via ChatGPT Pro OAuth with fallback to `openrouter/minimax/minimax-m2.7`. Achieves ~40% token reduction (~5000 → ~2400 tokens/day).

**cron_pipeline_collector_agent_refactor** — Phase 1 validation completed. Tests pass; atomic wipe-before-write and per-source error handling confirmed. Morning pipeline rollout pending passive context changes documented in execution plan.

**health_audit_2026_04_08** — Remediation completed: model routing fix (requires `openrouter/` prefix), compaction threshold increased 20x (4000→80000), 4 cron targets corrected, `acpx 0.5.1` installed, `moltbot.json` archived, brv model switched from `openai/gpt-4.1-mini` to `minimax/minimax-m2.7`.

## Critical Rules

- Zero JSON files in `am/` or `pm/` triggers Telegram alert and EXIT
- `tomorrow.json` expires after 36 hours
- Data older than 2 hours flagged as stale
- Git push failures logged and continue; no retry
- Always use explicit model ID `openai-codex/gpt-5.4-mini` (not `gpt-mini` alias)

## Phase Status

| Phase | Status         | Description                                                                         |
| ----- | -------------- | ----------------------------------------------------------------------------------- |
| 0     | ✅ Complete    | Model routing to `openai-codex/gpt-5.4-mini`                                        |
| 1     | ✅ Complete    | Created collectors (`morning_collect.py`, `evening_collect.py`, `collect_utils.py`) |
| 2     | ✅ Complete    | Morning Pipeline validated with `lightContext` optimization                         |
| 3     | 🔄 In Progress | Evening Pipeline with Knowledge Processor and Evening Analyst                       |
| 3.5–6 | ⏳ Pending     | Operational file updates, weekly consolidation, cleanup, finalization               |

## Key Files

- `src/gateway/server-lanes.ts`
- `docs/plans/2026-04-10-001-refactor-cron-pipeline-collector-agent-architecture-plan.md`
- `/home/codex/clawd/USER.md`, `PRINCIPLES.md`, `TOOLS.md`
