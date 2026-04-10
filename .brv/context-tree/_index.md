---
children_hash: 03196a06a66a732ac8792d590035e07af91c2b6aec2b2f4a9ba8e24dd74f492e
compression_ratio: 0.8447837150127226
condensation_order: 3
covers: [project/_index.md]
covers_token_total: 393
summary_level: d3
token_count: 332
type: summary
---

# Project Operations Summary

## Overview

Operations domain covering system maintenance, configuration, and remediation. Excludes architecture decisions and feature development.

## Core Activities

### Collector-Agent Refactor

- **Entry**: `cron_pipeline_collector_agent_refactor`
- Phase 1 validated (tests passing)
- **Pattern**: Atomic wipe-before-write with per-source error isolation
- **Status**: Morning pipeline rollout awaiting passive context documentation

### Health Audit (2026-04-08)

- **Entry**: `health_audit_2026_04_08`
- **Fixes applied**:
  - Model routing: `openrouter/` prefix required for OpenRouter guardrail compliance
  - Compaction threshold: 4000→80000 (20x increase)
  - Cron targets: 4 delivery targets
  - Plugin config: 10 plugins allowed, acpx 0.5.1 installed
  - brv model: `minimax/minimax-mini`

## Architectural Patterns

- Atomic operations with per-source error isolation
- OpenRouter compliance driving routing prefix requirements
- 20x compaction threshold adjustment

## Dependencies

Collector-agent refactor depends on passive context changes in execution plan. Health audit fixes were self-contained.

## Drill-down

- `operations/cron_pipeline_collector_agent_refactor` — Detailed refactor documentation
- `operations/health_audit_2026_04_08` — Full audit findings and remediation
