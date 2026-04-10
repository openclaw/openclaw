---
title: Cron Pipeline Collector-Agent Architecture
tags: []
related: [project/operations/health_audit_2026_04_08.md]
keywords: []
importance: 50
recency: 1
maturity: draft
createdAt: "2026-04-10T10:33:27.982Z"
updatedAt: "2026-04-10T10:33:27.982Z"
---

## Raw Concept

**Task:**
Document cron pipeline architecture: replace 11 monolithic agent sessions with lightweight collectors feeding specialized agents

**Changes:**

- Phase 0 completed: Model routing to openai-codex/gpt-5.4-mini, removed OpenRouter API keys
- Phase 1 completed: Created morning_collect.py, evening_collect.py, collect_utils.py
- Phase 2 completed: Morning Pipeline live validated with lightContext optimization
- Phase 3: Evening Pipeline with Knowledge Processor and Evening Analyst
- Phases 3.5-6 pending: Operational file updates, weekly consolidation, cleanup, finalization

**Files:**

- src/gateway/server-lanes.ts

**Flow:**
Collectors (05:00, 20:00) -> JSON files in /tmp/openclaw-pipeline/am|pm/ -> Agents (05:10 Morning Planner, 20:30 Knowledge Processor, 21:15 Evening Analyst) -> Daily notes + tomorrow.json carry-forward

## Narrative

### Structure

9 active cron jobs: 3 collectors (300s timeout, ~200 tokens) + 6 agents (1800s timeout, ~300-500 tokens). Pipeline data exchange via /tmp/openclaw-pipeline/{am,pm,tomorrow.json}. Sequential execution via maxConcurrentRuns=1.

### Dependencies

Requires ext4 /tmp (survives reboots). Uses openai-codex/gpt-5.4-mini via ChatGPT Pro OAuth (zero marginal cost). Fallback: openrouter/minimax/minimax-m2.7.

### Highlights

40% token reduction: ~5000 → ~2400 tokens/day focused reasoning + ~600 collector overhead. Runtime defect: live sessions start on model=gpt-5.4 instead of gpt-5.4-mini.

### Rules

Rule 1: If am/ or pm/ has 0 JSON files, send Telegram alert and EXIT without degraded briefing
Rule 2: tomorrow.json expires after 36 hours
Rule 3: Data older than 2 hours flagged as stale
Rule 4: Git push failures logged and continue, no retry
Rule 5: Always use explicit model ID openai-codex/gpt-5.4-mini (not gpt-mini alias which resolves to openai/gpt-5.4-mini)

### Examples

Example pipeline handoff: Evening Analyst writes tomorrow.json (21:15) -> Morning Planner reads tomorrow.json (05:10) with unfinished_threads, blockers, key_context, readwise_project_map
