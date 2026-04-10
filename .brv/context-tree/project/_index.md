---
children_hash: e9c280def25927943e693b5e6a9c286cf84447a7378a9b1b1158f845b9eab9fd
compression_ratio: 0.7465753424657534
condensation_order: 2
covers: [context.md, operations/_index.md]
covers_token_total: 438
summary_level: d2
token_count: 327
type: summary
---

# Project Operations

## Overview

Operational domain for system maintenance, configuration, and remediation.

## Scope

Health audits, configuration changes, remediation actions, operational procedures. Excludes architecture decisions and feature development.

## Key Activities

### Collector-Agent Refactor (cron_pipeline_collector_agent_refactor)

Phase 1 validated with tests passing. Implements atomic wipe-before-write pattern with per-source error isolation. Morning pipeline rollout awaiting passive context documentation.

### Health Audit (health_audit_2026_04_08)

Single-session remediation addressing:

- **Model routing**: Requires `openrouter/` prefix for OpenRouter guardrail compliance
- **Compaction threshold**: 4000→80000 (20x increase)
- **Cron targets**: 4 delivery targets configured
- **Plugin config**: 10 plugins allowed, acpx 0.5.1 installed
- **brv model**: minimax/minimax-mini

## Architectural Patterns

- Atomic operations with per-source error isolation
- OpenRouter compliance driving routing changes
- 20x compaction threshold adjustment

## Dependencies

Collector-agent refactor depends on passive context changes in execution plan. Health audit fixes were self-contained.

---

Drill-down: See `operations/_index.md` for detailed coverage of refactor and audit entries.
