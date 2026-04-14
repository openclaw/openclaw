# Completion: system-design-judge-v1

## What was done

### Stage 0-1: Routing Lane Type System (`src/agents/routing-lanes.ts`)

- `RoutingLane` type with 7 named lanes: routine, orchestrator_high, executor_codex, research, judge_deterministic, judge_semantic, challenger
- `RouteReason` type: primary, session_override, cron_override, config_override, failover, escalation, challenger_invocation, user_request
- `EscalationReason` type (separate from failover): revise_loop_exceeded, architecture_conflict, migration_risk, root_cause_ambiguity, user_requested, judge_escalate
- `RouteMetadata` interface with lane, routeReason, requestedModel, selectedModel, actualModel, failoverReason, escalationReason, challengerInvoked, challengerReason
- `LANE_DESCRIPTIONS` lookup for operator-facing surfaces
- `inferRoutingLane()` heuristic from agent ID and model patterns
- `buildRouteMetadata()` builder from model selection context

### Stage 2: Judge Gate Architecture (`src/agents/judge-gate.ts`)

- `JudgeVerdict` type: ACCEPT, REVISE, ESCALATE
- `DeterministicGateResult` and `DeterministicCheck` interfaces for preflight gates
- `JudgeOutcome` interface with verdict, rationale, blockingIssues, reviseCount, deterministicGateResult, timestamp, judgeModel, taskId
- `persistJudgeOutcome()` — writes to `.openclaw/reviews/<task-id>/judge.json`
- `loadJudgeOutcome()` — reads back from disk
- `isJudgeAccepted()` — acceptance check
- `shouldEscalateAfterRevise()` — escalation threshold check (default max 2)

### Stage 3: Challenger Lane Scaffold (`src/agents/challenger-lane.ts`)

- `ChallengerTrigger` type: revise_loop_exceeded, architecture_conflict, migration_risk, root_cause_ambiguity, user_requested
- `ChallengerResponseKind` type: counter_brief, alternate_patch_plan, root_cause_memo, explicit_disagreement
- `ChallengerOutcome` interface
- `ChallengerLaneConfig` interface with enabled flag (default: false)
- `isChallengerEnabled()` — config check
- `shouldInvokeChallenger()` — trigger policy with revise threshold, max invocations

## What was intentionally NOT done

- Hook system integration (adding route metadata to llm_output events) — requires deeper integration into hooks.ts dispatch
- Status surface integration (enriching status --all --json) — requires changes to report-data.ts and format.ts
- Task registry field extensions — requires schema changes to task-registry.types.ts
- Config schema changes for challengerLane — requires changes to config/schema.base.generated.ts
- Live routing enforcement — new types are available for integration but not yet wired into the hot path

## Verification

- 30/30 new tests pass
- No existing tests affected (new files only, no modifications to existing code)
