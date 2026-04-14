# Contract: system-design-judge-v1

## Objective

Add first-class routing lane types, judge gate architecture, and challenger lane scaffold to the OpenClaw source repo.

## Acceptance Criteria

1. New `RoutingLane` type and lane definitions exist
2. Route metadata fields (`route_reason`, `failover_reason`, `escalation_reason`, `requested_model`, `selected_model`) are defined
3. Lane inference from agent ID and model patterns works
4. `JudgeVerdict`/`JudgeOutcome` types exist with file-based persistence
5. Deterministic gate result types defined
6. Judge outcome persistence round-trips correctly
7. Challenger lane scaffolded behind a config flag (disabled by default)
8. Challenger trigger policy enforces revise_count >= 2 threshold
9. All new tests pass
10. No existing tests broken

## Scope

- Stage 0-1: RoutingLane type system, lane inference, route metadata builder
- Stage 2: JudgeVerdict/JudgeOutcome types, persistence, acceptance checks
- Stage 3: Challenger trigger policy scaffold (disabled by default)

## Out of Scope (this pass)

- Hook system integration (llm_output enrichment)
- Status surface integration (status --all --json)
- Task registry field extensions
- Live routing enforcement
- Stage 4 security hardening
