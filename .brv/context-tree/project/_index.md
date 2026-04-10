---
children_hash: d8c573cd15c2df97aafca53e82c76676a8004512f9d7d0861372cc1b1155ef32
compression_ratio: 0.6405405405405405
condensation_order: 2
covers: [context.md, operations/_index.md]
covers_token_total: 740
summary_level: d2
token_count: 474
type: summary
---

# project/operations

## Overview

Operational knowledge for OpenClaw's cron pipeline architecture and maintenance. Replaced 11 monolithic agent sessions with lightweight collectors feeding specialized agents.

## Architecture

**Pipeline Structure**: 9 active cron jobs — 3 collectors (300s timeout), 6 agents (1800s timeout). Data exchange via `/tmp/openclaw-pipeline/{am,pm,tomorrow.json}`. Model: `openai-codex/gpt-5.4-mini` via ChatGPT Pro OAuth with `minimax/minimax-m2.7` fallback.

**Token Efficiency**: ~40% reduction (5000 → ~2400 tokens/day).

## Status

- **Refactor Phase 1**: Complete — atomic wipe-before-write and per-source error handling validated
- **Phase 2**: Morning pipeline with `lightContext` optimization validated
- **Phase 3**: Evening pipeline with Knowledge Processor and Evening Analyst — in progress
- **Phases 3.5–6**: Pending — operational file updates, weekly consolidation, cleanup, finalization

## Critical Rules

- Zero JSON files in `am/`/`pm/` → Telegram alert + EXIT
- `tomorrow.json` expires after 36 hours
- Data older than 2 hours flagged stale
- Git push failures log and continue; no retry
- Use explicit model ID `openai-codex/gpt-5.4-mini` (not alias)

## Health Audit Remediation (2026-04-08)

Completed fixes: model routing (`openrouter/` prefix required), compaction threshold (4000→80000), 4 cron targets corrected, `acpx 0.5.1` installed, `moltbot.json` archived, brv model switched to `minimax/minimax-m2.7`.

## Key Files

- `src/gateway/server-lanes.ts`
- `docs/plans/2026-04-10-001-refactor-cron-pipeline-collector-agent-architecture-plan.md`
- `/home/codex/clawd/USER.md`, `PRINCIPLES.md`, `TOOLS.md`

## Child Entry Reference

- `cron_pipeline_collector_agent_architecture` — Core architecture details
- `cron_pipeline_collector_agent_refactor` — Phase 1 validation and execution plan
- `health_audit_2026_04_08` — Remediation actions
