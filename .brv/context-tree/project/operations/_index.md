---
children_hash: 634a409d72004bba54a41232c56ccc39f6135be269d1ed60dd11bd61314e409f
compression_ratio: 0.3988522238163558
condensation_order: 1
covers: [cron_pipeline_collector_agent_refactor.md, health_audit_2026_04_08.md]
covers_token_total: 697
summary_level: d1
token_count: 278
type: summary
---

# Project Operations

## Overview

Operational domain covering system health maintenance and collector-agent infrastructure refactoring.

## Key Activities

### Phase 1 Validation

- **cron_pipeline_collector_agent_refactor**: Phase 1 collector-agent refactor validated. Tests pass, atomic wipe-before-write pattern confirmed, per-source error handling working. Morning pipeline rollout pending passive context documentation completion.

### Health Remediation

- **health_audit_2026_04_08**: Single-session remediation addressing model routing (requires `openrouter/` prefix), compaction threshold (4000→80000), 4 cron delivery targets, plugin configuration (10 plugins allowed, acpx 0.5.1 installed), and brv model switch (minimax/minimax-m2.7).

## Patterns

- Atomic operations with per-source error isolation
- OpenRouter guardrail compliance driving model routing changes
- 20x compaction threshold adjustment

## Relationships

Collector-agent refactor depends on passive context changes documented in execution plan. Health audit fixes were self-contained with OpenRouter compliance as the primary driver.
