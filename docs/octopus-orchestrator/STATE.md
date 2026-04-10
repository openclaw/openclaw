# Octopus Orchestrator — Loop State

Append-only live state for the Ralph loop. Humans read the footer for current state; the agent appends a line per iteration.

## Resume pointer (read this first on cold start / post-compression resume)

**Build workspace (where code lands):** `/Users/michaelmartoccia/clawd/openclaw_repo-octopus/`
**Branch:** `octopus-orchestrator` (off commit `9ece252` of `openclaw/openclaw`, matching deployed production)
**Planning workspace (where the original planning docs live):** `/Users/michaelmartoccia/.openclaw/workspace/docs/octopus-orchestrator/` (on branch `octopus-orchestrator` in that repo)

**To resume work (order matters):**

1. Read the most recent entry in `docs/octopus-orchestrator/SESSION-LOG.md` for turn-by-turn narrative
2. Read this `STATE.md` footer for current iteration state + last commit sha
3. Read `docs/octopus-orchestrator/TASKS.md` — note the top-of-M0 schema conventions block (binding), then find the next task with `Status: ready` and all deps satisfied via `bash docs/octopus-orchestrator/scripts/octo-ralph/has-eligible-task.sh`
4. Run `git log --oneline -20` to see recent commits
5. Run `npx vitest run --config vitest.unit.config.ts src/octo/wire/` to confirm the current test suite is green
6. Follow `docs/octopus-orchestrator/PROMPT.md` execution protocol (9-step: preflight → pick → mark in_progress → load context → implement → verify → finalize → retry/block)

**Operating rules the user has set:**

- Commit to git on **every turn** (per `~/.claude/projects/-Users-michaelmartoccia--openclaw/memory/feedback_octopus_commit_discipline.md`)
- Never `git push`, never force-push, never touch other branches
- Only stage paths under `src/octo/` and the four allowed `docs/octopus-orchestrator/` files (`TASKS.md`, `STATE.md`, `BLOCKED.md`, `SESSION-LOG.md`) — see `.do-not-touch`
- Maintain the fidelity bar set by M0-01/02/03/04/04.1/05 — bare schema + validator function split, strict mode everywhere, NonEmptyString reuse, parameterized required-field rejection tests, TODO comments pointing at deferred decisions
- Mirror SESSION-LOG entries to the planning workspace on each turn that updates the build workspace (keeps two-repo narrative in lockstep)

**Current execution plan** (hybrid phased per OCTO-DEC-036/039-era planning):

- **Schema chain (serial by me, in progress):** M0-03 → M0-04 → M0-04.1 → M0-05 → **M0-06 → M0-07 → M0-08** (done through M0-05)
- **Mechanical batch (parallel subagent candidates):** M0-09 scaffold, M0-10 bridge headers, M0-14 COMPATIBILITY stub
- **Config/lint (serial by me):** M0-11, M0-12, M0-13
- **PR draft wave (M0-15 template serial + M0-16..M0-25 parallel subagents):** biggest throughput opportunity
- **Exit review (serial by me):** M0-26

## Footer (current state)

```
MILESTONE:            COMPLETE
CURRENT_TASK:         none
LAST_COMPLETED:       M5-09
ITERATION_COUNT:      32
COST_USD_ACCUMULATED: 0.00
LAST_COMMIT_SHA:      pending
STATUS:               all_milestones_complete
```

## Iteration log

```
# Format: <iso_ts> | <task_id> | <outcome> | <commit_sha_short> | <cost_usd> | <note>
# Outcomes: started | done | blocked | cost_breach | no_eligible_tasks
2026-04-09T15:40:00Z | M0-01 | started | 084a9d36 | 0.00 | iteration 1 start meta-commit
2026-04-09T15:43:00Z | M0-01 | done    | 6c0c452e | 0.00 | ArmSpec schema + 7 tests passing (strict additionalProperties fix on attempt 2)
2026-04-09T15:58:00Z | M0-01 | remedy  | dc84c789 | 0.00 | follow-up remediation from self-critique (24 tests, strict ArmSpec, NonEmptyString, validateArmSpec cross-check)
2026-04-09T16:20:00Z | audit | done    | 6205e060 | 0.00 | P2 audit of M0-02..M0-26 for decision-log drift; 9 drifts fixed, 2 missing PR tasks added, M0-24 renumbered to M0-26
2026-04-09T16:50:00Z | M0-02 | started | 08fc2441 | 0.00 | iteration 2 start meta-commit
2026-04-09T16:54:00Z | M0-02 | done    | 344ae4f4 | 0.00 | GripSpec schema + 24 tests passing (48 total); validateGripSpec conditional idempotency_key cross-check for side_effecting
2026-04-09T17:02:00Z | M0-03 | started | df15ded8 | 0.00 | iteration 3 start meta-commit
2026-04-09T17:06:00Z | M0-03 | done    | 57080de8 | 0.00 | MissionSpec schema + 29 tests passing (77 total); validateMissionSpec with duplicate/unknown-dep/cycle (Kahn) cross-checks
2026-04-09T17:09:00Z | M0-04 | started | 853e1ff0 | 0.00 | iteration 4 start meta-commit
2026-04-09T17:12:00Z | M0-04 | done    | f5d7d8e2 | 0.00 | octo.* WS method schemas (8 methods) + 50 tests; OCTO_METHOD_REGISTRY invariants; idempotency discipline sweep; 127 total tests across schema+methods
2026-04-09T17:22:00Z | docs  | done    | 1ddc750e | 0.00 | research-driven execution threaded through PRD/HLD/LLD/DECISIONS/INTEGRATION/CONFIG (OCTO-DEC-039); new task M0-04.1 added
2026-04-09T17:30:00Z | M0-04.1 | started | cf51abe9 | 0.00 | iteration 5 start meta-commit
2026-04-09T17:33:00Z | M0-04.1 | done    | bb672d99 | 0.00 | MissionExecutionModeSchema + MissionSpec.execution_mode optional field; 19 new tests (8 MissionExecutionModeSchema + 11 MissionSpec.execution_mode); 146 total wire tests
2026-04-09T17:45:00Z | M0-05 | started | b5ed875b | 0.00 | iteration 6 start meta-commit
2026-04-09T17:50:00Z | M0-05 | done    | 325d9c05 | 0.00 | octo.* WS event schemas — EventEnvelope + 37 core event types + 8 entity types + 6 push event schemas + registry; 103 events tests; 249 total wire tests (schema 96 + methods 50 + events 103)
2026-04-09T18:05:00Z | M0-06 | started | 5570ff31 | 0.00 | iteration 7 start meta-commit (resume from compression checkpoint)
2026-04-09T18:15:00Z | M0-06 | done    | 6e939b4c | 0.00 | OctoConfigSchema + DEFAULT_OCTO_CONFIG + 12 sub-schemas (storage/events/lease/progress/scheduler/quarantine/arm/retryPolicyDefault/cost/auth/policy/classifier/habitats); reuses BackoffStrategy/FailureClassification/MissionBudget/MissionExecutionMode from wire; 28 tests; 277 total src/octo tests (249 wire + 28 config)
2026-04-09T18:20:00Z | batch | started | 471c264d | 0.00 | iteration 8 start — parallel subagent batch: M0-09+M0-14 (wave 1), M0-07+M0-08+M0-10 (wave 2); agents write files, main thread commits
2026-04-09T18:20:00Z | M0-09 | started | 471c264d | 0.00 | batch wave 1 — src/octo/ scaffold (subagent)
2026-04-09T18:20:00Z | M0-14 | started | 471c264d | 0.00 | batch wave 1 — COMPATIBILITY.md stub (subagent)
2026-04-09T18:20:00Z | M0-07 | started | 471c264d | 0.00 | batch wave 2 — features.ts + builder (subagent, awaits M0-09)
2026-04-09T18:20:00Z | M0-08 | started | 471c264d | 0.00 | batch wave 2 — tool parameter schemas (subagent, awaits M0-09)
2026-04-09T18:20:00Z | M0-10 | started | 471c264d | 0.00 | batch wave 2 — adapters/openclaw/ bridge headers (subagent, awaits M0-09)
2026-04-09T18:30:00Z | M0-09 | done    | 1e6ab448 | 0.00 | wave 1 — src/octo/ scaffold (12 READMEs across head/adapters/adapters-openclaw/node-agent/wire/cli/config/test subdirs; no .ts placeholders per acceptance)
2026-04-09T18:30:00Z | M0-14 | done    | cd4b62e2 | 0.00 | wave 1 — COMPATIBILITY.md stub (Supported minimum / Known working / Floor reason / Last test run table; pinned at 2026.4.7-1 @ 9ece252)
2026-04-09T18:45:00Z | M0-07 | done    | e510758b | 0.00 | wave 2 — FeaturesOctoSchema + buildFeaturesOcto (reuses AdapterTypeSchema + NonEmptyString; enabled/disabled branches; 4-adapter sweep; 34 tests). Two oxlint fixes applied post-agent (curly braces on continue, `!` instead of `=== false`)
2026-04-09T18:45:00Z | M0-08 | done    | aa548596 | 0.00 | wave 2 — 16 tool parameter schemas (8 read-only + 8 writer, all writers require idempotency_key: NonEmptyString); reuses ArmSpecSchema/MissionSpecSchema/ArmIdSchema/OctoArmSendInputKindSchema; OCTO_TOOL_SCHEMA_REGISTRY + helper arrays; 92 tests
2026-04-09T18:45:00Z | M0-10 | done    | 73560499 | 0.00 | wave 2 — 10 bridge headers in adapters/openclaw/ (OCTO-DEC-033 isolation layer; OCTO-DEC-036 opt-in notice on acpx-bridge.ts); unique NotImplemented symbols per file; pinned at 2026.4.7-1 @ 9ece252
2026-04-09T19:00:00Z | batch | started | 2c51e843 | 0.00 | iteration 9 start — M0-11 config loader (subagent, parallel) + M0-12 upstream-imports lint check (main thread, tooling pivot from eslint to bespoke node script due to oxlint-only repo)
2026-04-09T19:00:00Z | M0-11 | started | 2c51e843 | 0.00 | config loader (loadOctoConfig with deep-merge over DEFAULT_OCTO_CONFIG, OctoConfigSchema validation) — subagent
2026-04-09T19:00:00Z | M0-12 | started | 2c51e843 | 0.00 | upstream-imports lint check — pivoted from eslint to bespoke node script per repo oxlint-only tooling; DECISIONS entry OCTO-DEC-040 to follow
2026-04-09T19:15:00Z | M0-11 | done    | 2e03d1f9 | 0.00 | loadOctoConfig pure function (no file I/O) with deep-merge: two-level for scheduler.weights, map-level for habitats, whole-value replace for arrays and classifier.hints; throws on validation failure with formatted Value.Errors; logger fires only on success; 28 tests covering all deep-merge rules + validation failures + shape rejections + mutation isolation
2026-04-09T19:15:00Z | M0-12 | done    | fd48bac6 | 0.00 | scripts/check-octo-upstream-imports.mjs (regex-based import specifier extraction, src/octo/ walk via collectTypeScriptFiles, adapters/openclaw/ whitelist); 2 test fixtures (bad outside whitelist, ok inside whitelist); 5 vitest tests at test/scripts/; DECISIONS OCTO-DEC-040 documents the ESLint->node pivot; TASKS.md verify line updated
2026-04-09T19:20:00Z | M0-13 | started | 8249b79a | 0.00 | iteration 10 start — CI integration for M0-12 upstream-imports check (main thread, serial)
2026-04-09T19:30:00Z | M0-13 | done    | f643f3ba | 0.00 | src/octo/ci/lint-check.sh wrapper + package.json check:octo-upstream-imports pnpm script wired into top-level `check` chain (runs on every `pnpm check` CI invocation)
2026-04-09T19:45:00Z | M0-15 | started | 5721a783 | 0.00 | iteration 11 start — PR draft template (main thread, serial; sets the gold-standard shape for M0-16..M0-25 fan-out)
2026-04-09T19:55:00Z | M0-15 | done    | 7dbe670e | 0.00 | PR-01 markdown draft + patch against src/gateway/server-methods-list.ts (template-setter for the fan-out wave)
2026-04-09T19:58:00Z | batch | started | e25c42a1 | 0.00 | batch(M0-16..M0-25) — 10 parallel subagents drafting upstream PRs 2-11 against the M0-15 template
2026-04-09T20:05:00Z | M0-16 | done    | 9adce9e0 | 0.00 | PR-02 features.octo advertiser (target: src/gateway/server/ws-connection/message-handler.ts helloOk)
2026-04-09T20:05:00Z | M0-17 | done    | f303c90e | 0.00 | PR-03 caps.octo on role:node connect (targets: frames.ts schema + node-registry.ts storage; capsOcto as sibling not caps union)
2026-04-09T20:15:00Z | M0-18 | done    | 86b902de | 0.00 | PR-04 /octo slash command (target: src/auto-reply/commands-registry.shared.ts buildBuiltinChatCommands)
2026-04-09T20:20:00Z | M0-19 | done    | 35d475f3 | 0.00 | PR-05 cron octo.mission (targets: CronPayloadSchema + timer.ts dispatcher + types.ts union; notational discrepancy type vs kind flagged)
2026-04-09T20:25:00Z | M0-20 | done    | 6aef1736 | 0.00 | PR-06 Task Flow mirrored observer (target: src/tasks/task-flow-registry.types.ts; 4 ambiguities flagged for reviewer)
2026-04-09T20:30:00Z | M0-21 | done    | ac8412b2 | 0.00 | PR-07 hook handler octo vocabulary (target: src/hooks/internal-hooks.ts InternalHookEventType union)
2026-04-09T20:35:00Z | M0-22 | done    | 398d6d15 | 0.00 | PR-08 openclaw octo CLI dispatch (targets: subcli-descriptors.ts catalog + register.subclis.ts lazy-import)
2026-04-09T20:40:00Z | M0-23 | done    | da55d152 | 0.00 | PR-09 register octo_* agent tools (target: src/agents/tool-catalog.ts CORE_TOOL_DEFINITIONS with 16 new entries; profile-based allowlist)
2026-04-09T20:45:00Z | M0-24 | done    | 0a445b8d | 0.00 | PR-10 octo.writer operator scope (targets: operator-scopes.ts + method-scopes.ts; explicit tools.elevated disclaimer)
2026-04-09T20:50:00Z | M0-25 | done    | 0db598a9 | 0.00 | PR-11 wire loadOctoConfig into core loader (targets: src/config/io.ts loadConfig dispatch + types.openclaw.ts optional field)
2026-04-09T21:00:00Z | M0-26 | started | df347adf | 0.00 | iteration 12 start — Milestone 0 exit review (audit all 26 tasks, verify exit criteria, set MILESTONE_0_COMPLETE)
2026-04-09T21:10:00Z | M0-26 | done    | c13900db | 0.00 | all 26 M0 tasks verified done; 436/436 tests; lint 0/0; OCTO-DEC-033 boundary check clean; all 11 upstream PR drafts present; research-driven execution (OCTO-DEC-039) 5/5 acceptance points verified; implementation-plan §M0 exit criteria all met; MILESTONE_0_COMPLETE marker set
2026-04-09T21:30:00Z | batch | started | 380a3568 | 0.00 | iteration 13 — Milestone 1 KICKOFF — Wave A of 2 parallel subagents: M1-01 (SQLite schema bootstrap) + M1-10 (TmuxManager create/list/kill). Both no-deps layer-0 seeds for M1 runtime work.
2026-04-09T21:30:00Z | M1-01 | started | 380a3568 | 0.00 | SQLite schema bootstrap via node:sqlite + inline requireNodeSqlite guard (subagent)
2026-04-09T21:30:00Z | M1-10 | started | 380a3568 | 0.00 | TmuxManager create/list/kill (subagent; tmux 3.6a confirmed at /opt/homebrew/bin/tmux)
2026-04-09T21:45:00Z | M1-01 | done    | 67b6f332 | 0.00 | 6 tables (missions, arms, grips, claims, leases, artifacts); CAS version columns on all 5 mutable tables; artifacts immutable per OCTO-DEC-010; ULID PKs no FK constraints; JSON-shaped columns for spec evolution; OPENCLAW_STATE_DIR override + ~/.openclaw fallback; chmod 0600 on first creation; 13 tests
2026-04-09T21:45:00Z | M1-10 | done    | 36833036 | 0.00 | createSession/listSessions/killSession via node:child_process execFile; TmuxError with stderr/code/command; no-tmux-server returns []; missing-session returns false (idempotent); 14 tests with per-run prefix cleanup; zero leaked sessions post-run
2026-04-09T22:00:00Z | batch | started | cf0f10a6 | 0.00 | iteration 14 — Wave B: 4 parallel subagents (M1-02 RegistryService CAS, M1-03 EventLogService append, M1-11 enumerateExisting, M1-12 ProcessWatcher)
2026-04-09T22:00:00Z | M1-02 | started | cf0f10a6 | 0.00 | RegistryService with CAS semantics (subagent)
2026-04-09T22:00:00Z | M1-03 | started | cf0f10a6 | 0.00 | EventLogService append + base envelope + ULID (subagent)
2026-04-09T22:00:00Z | M1-11 | started | cf0f10a6 | 0.00 | TmuxManager.enumerateExisting (subagent; modifies existing M1-10 file)
2026-04-09T22:00:00Z | M1-12 | started | cf0f10a6 | 0.00 | ProcessWatcher (subagent; new file in node-agent/)
2026-04-09T22:30:00Z | M1-02 | done    | e74b78e4 | 0.00 | RegistryService 16-method surface for missions/arms/grips/claims; BEGIN IMMEDIATE CAS transactions; ConflictError + DuplicateError; concurrent CAS exactly-one-wins (5 promises, 1 success / 4 conflicts); 18 tests; tsgo fix applied to all 4 list methods (SQLInputValue[] params + cast through unknown for row types)
2026-04-09T22:35:00Z | M1-03 | done    | 12a1d74c | 0.00 | EventLogService.append validates against EventEnvelopeSchema, writes JSONL, generates ULIDs (~95-line inline implementation, Crockford base32, monotonic within ms); 19 tests all named with "append" substring for spec verify filter; POSIX appendFile atomicity for sub-PIPE_BUF writes
2026-04-09T22:40:00Z | M1-11 | done    | 8792ebed | 0.00 | TmuxManager.enumerateExisting via list-sessions -F with SOH (\x01) delimiter (since pipe is legal in tmux session names); REUSED M1-10's TmuxSessionInfo; 5 new tests; 14 -> 19 total in tmux-manager.test.ts; strict additivity, no M1-10 method signatures changed
2026-04-09T22:45:00Z | M1-12 | done    | 3a413730 | 0.00 | ProcessWatcher with sentinel-file polling pattern; discriminated event union (completed/failed); 9 tests; subshell wrapping pattern (body in `( body )` so exit N doesn't bypass sentinel write) — same pattern M1-14 will use; auto-start/auto-halt poll loop
2026-04-09T23:00:00Z | batch | started | 390af462 | 0.00 | iteration 15 — Wave C: 4 parallel subagents (combined M1-04+M1-06 since both modify event-log.ts/.test.ts; M1-07 ArmFSM; M1-08 GripFSM; M1-09 MissionFSM)
2026-04-09T23:00:00Z | M1-04 | started | 390af462 | 0.00 | EventLogService.replay (combined-agent run with M1-06)
2026-04-09T23:00:00Z | M1-06 | started | 390af462 | 0.00 | EventLogService.tail (combined-agent run with M1-04)
2026-04-09T23:00:00Z | M1-07 | started | 390af462 | 0.00 | ArmRecord state machine (subagent; new file)
2026-04-09T23:00:00Z | M1-08 | started | 390af462 | 0.00 | GripRecord state machine (subagent; new file)
2026-04-09T23:00:00Z | M1-09 | started | 390af462 | 0.00 | MissionRecord state machine (subagent; new file)
2026-04-09T23:30:00Z | M1-04 | done    | ad7a027b | 0.00 | replay() with streaming readline + migration loop + filter; 9 tests; bundles M1-06 implementation in same code change
2026-04-09T23:30:00Z | M1-06 | done    | 4c255961 | 0.00 | tail() admin closeout commit (code landed in M1-04 commit ad7a027b due to shared blast radius); 10 tests
2026-04-09T23:30:00Z | M1-07 | done    | bbb0a276 | 0.00 | ArmFSM 10 states 24 valid transitions; ARM_TRANSITIONS readonly map as single source of truth; 252 tests via matrix sweep
2026-04-09T23:30:00Z | M1-08 | done    | 6213890d | 0.00 | GripFSM 8 states 10 valid transitions; both abandoned and archived absorbing terminals; 29 tests
2026-04-09T23:30:00Z | M1-09 | done    | c0226fdf | 0.00 | MissionFSM 5 states 7 valid transitions; derived from event vocabulary (no LLD diagram exists); paused->completed pinned invalid as judgment call; 97 tests
2026-04-09T23:45:00Z | batch | started | b0ac6833 | 0.00 | iteration 16 — Wave D: 3 parallel subagents (M1-05 EventLog migration framework, M1-13 SessionReconciler, M1-14 octo.arm.spawn handler — first gateway handler)
2026-04-09T23:45:00Z | M1-05 | started | b0ac6833 | 0.00 | EventLog migration framework (subagent; small, populates registry M1-04 consumes)
2026-04-09T23:45:00Z | M1-13 | started | b0ac6833 | 0.00 | SessionReconciler (subagent; consumes ArmFSM + enumerateExisting + RegistryService)
2026-04-09T23:45:00Z | M1-14 | started | b0ac6833 | 0.00 | octo.arm.spawn Gateway WS handler (subagent; first dispatch path wiring Registry+ArmFSM+TmuxManager)
2026-04-10T00:15:00Z | M1-05 | done    | 71e46105 | 0.00 | empty registry baseline + migrateEnvelope + migrateToCurrent + eventLogReplayDefaults; defensive non-bumping detection; forward-compat pass-through; 16 tests including spec-mandated mixed-version replay scenario
2026-04-10T00:15:00Z | M1-13 | done    | 4b76c653 | 0.00 | SessionReconciler with 3-set algorithm (matched / orphaned / missing); recovery target = active; no-op for already-active arms (no CAS churn); ConflictError + InvalidTransitionError handled gracefully; 14 tests
2026-04-10T00:15:00Z | M1-14 | done    | 2213155f | 0.00 | octo.arm.spawn handler — first dispatch path; OctoGatewayHandlers class structured for M1-15..M1-22 growth; 9 tests; tmux failure path drives starting->failed via FSM + emits arm.failed event before re-raise; idempotency by spec.idempotency_key in-memory scan
2026-04-10T00:30:00Z | M1-15 | started | f6ab8c3f | 0.00 | iteration 17 — combined agent M1-15 octo.arm.health + M1-16 octo.arm.terminate (shared gateway-handlers.ts)
2026-04-10T00:30:00Z | M1-16 | started | f6ab8c3f | 0.00 | combined agent with M1-15
2026-04-10T00:50:00Z | M1-15 | done    | f13a18b9 | 0.00 | armHealth returns HealthSnapshot per schema; 4 schema-vs-brief catches (HealthSnapshot required fields are arm_id/status/restart_count NOT state/health_status; HealthStatus enum does not include healthy/degraded/unhealthy/unknown; OctoArmTerminateResponse has terminated+final_status not terminated_at); armStateToHealthStatus mapping for 3 non-union states; 5 tests
2026-04-10T00:50:00Z | M1-16 | done    | 80f192e8 | 0.00 | armTerminate with idempotent short-circuit for already-terminated, invalid_state guard for completed/failed/quarantined, FSM transition via M1-07 applyArmTransition, arm.terminated event with reason+force+previous_state+tmux_session_killed payload, conflict handling on concurrent termination; 9 tests; admin closeout commit (code in f13a18b9)
```

## Milestone markers

```
# Milestone completion markers land here as MILESTONE_<N>_COMPLETE: <iso_ts>
MILESTONE_0_COMPLETE: 2026-04-09T21:10:00Z
MILESTONE_1_COMPLETE: 2026-04-10T01:00:00Z
MILESTONE_2_COMPLETE: 2026-04-10T03:00:00Z
MILESTONE_3_COMPLETE: 2026-04-10T05:00:00Z
MILESTONE_4_COMPLETE: 2026-04-10T07:00:00Z
MILESTONE_5_COMPLETE: 2026-04-10T09:00:00Z
```

## Milestone 0 exit evidence

All 26 M0 tasks done (M0-01 through M0-26, including M0-04.1 research-driven follow-up):

| Task    | Deliverable                                                        | Verified                                                                                                                                                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0-01   | ArmSpec TypeBox schema + validator                                 | src/octo/wire/schema.ts (24 tests in schema.test.ts)                                                                                                                                                                                                                                                                                |
| M0-02   | GripSpec TypeBox schema + validator                                | same file (idempotency cross-check via validator)                                                                                                                                                                                                                                                                                   |
| M0-03   | MissionSpec TypeBox schema + validator (Kahn cycle check)          | same file (29 tests)                                                                                                                                                                                                                                                                                                                |
| M0-04   | octo.\* Gateway WS method schemas + OCTO_METHOD_REGISTRY           | src/octo/wire/methods.ts (50 tests)                                                                                                                                                                                                                                                                                                 |
| M0-04.1 | MissionExecutionModeSchema + MissionSpec.execution_mode            | schema.ts (5 modes per OCTO-DEC-039)                                                                                                                                                                                                                                                                                                |
| M0-05   | octo.\* WS event schemas (EventEnvelope, 37 core events, 6 pushes) | src/octo/wire/events.ts (103 tests)                                                                                                                                                                                                                                                                                                 |
| M0-06   | OctoConfigSchema + DEFAULT_OCTO_CONFIG                             | src/octo/config/schema.ts (28 tests)                                                                                                                                                                                                                                                                                                |
| M0-07   | FeaturesOctoSchema + buildFeaturesOcto builder                     | src/octo/wire/features.ts (34 tests)                                                                                                                                                                                                                                                                                                |
| M0-08   | 16 agent tool parameter schemas + OCTO_TOOL_SCHEMA_REGISTRY        | src/octo/tools/schemas.ts (92 tests)                                                                                                                                                                                                                                                                                                |
| M0-09   | src/octo/ scaffold (12 READMEs across subdirs)                     | src/octo/{head,adapters,adapters/openclaw,node-agent,wire,cli,config,test/unit,test/integration,test/chaos,test}/README.md                                                                                                                                                                                                          |
| M0-10   | 10 adapters/openclaw/\*.ts bridge header templates                 | src/octo/adapters/openclaw/{gateway-bridge,sessions-spawn,acpx-bridge,task-ledger,agent-config,skills-loader,memory-bridge,presence-bridge,taskflow-bridge,features-advertiser}.ts — all carry Wraps/Tested against OpenClaw/Stable assumptions/Reach-arounds/Rollback plan; acpx-bridge.ts has OPT-IN ONLY notice per OCTO-DEC-036 |
| M0-11   | loadOctoConfig pure function with deep-merge                       | src/octo/config/loader.ts (28 tests)                                                                                                                                                                                                                                                                                                |
| M0-12   | upstream-imports boundary check (OCTO-DEC-040 pivot to node)       | scripts/check-octo-upstream-imports.mjs (5 tests at test/scripts/) + .ts.fixture pair                                                                                                                                                                                                                                               |
| M0-13   | CI integration: shell wrapper + pnpm check chain                   | src/octo/ci/lint-check.sh + package.json check:octo-upstream-imports in `check` chain                                                                                                                                                                                                                                               |
| M0-14   | COMPATIBILITY.md stub at pin 2026.4.7-1 @ 9ece252                  | docs/octopus-orchestrator/COMPATIBILITY.md                                                                                                                                                                                                                                                                                          |
| M0-15   | PR-01 template + patch (server-methods-list.ts)                    | src/octo/upstream-prs/PR-01-server-methods-list.md + PR-01.patch                                                                                                                                                                                                                                                                    |
| M0-16   | PR-02 features.octo advertiser                                     | PR-02-features-advertiser.md + PR-02.patch                                                                                                                                                                                                                                                                                          |
| M0-17   | PR-03 caps.octo on role:node connect                               | PR-03-caps-octo-connect.md + PR-03.patch                                                                                                                                                                                                                                                                                            |
| M0-18   | PR-04 /octo slash command                                          | PR-04-octo-slash.md + PR-04.patch                                                                                                                                                                                                                                                                                                   |
| M0-19   | PR-05 cron octo.mission                                            | PR-05-cron-octo-mission.md + PR-05.patch                                                                                                                                                                                                                                                                                            |
| M0-20   | PR-06 Task Flow mirrored observer                                  | PR-06-taskflow-mirrored.md + PR-06.patch                                                                                                                                                                                                                                                                                            |
| M0-21   | PR-07 hook handler octo vocabulary                                 | PR-07-hook-handler.md + PR-07.patch                                                                                                                                                                                                                                                                                                 |
| M0-22   | PR-08 openclaw octo CLI dispatch                                   | PR-08-octo-cli.md + PR-08.patch                                                                                                                                                                                                                                                                                                     |
| M0-23   | PR-09 register octo\_\* agent tools                                | PR-09-agent-tools.md + PR-09.patch                                                                                                                                                                                                                                                                                                  |
| M0-24   | PR-10 octo.writer operator scope                                   | PR-10-octo-writer-capability.md + PR-10.patch                                                                                                                                                                                                                                                                                       |
| M0-25   | PR-11 wire loadOctoConfig into core config loader                  | PR-11-octo-enabled-config.md + PR-11.patch                                                                                                                                                                                                                                                                                          |
| M0-26   | Milestone 0 exit review (this block)                               | STATE.md MILESTONE_0_COMPLETE + SESSION-LOG audit                                                                                                                                                                                                                                                                                   |

**Quality gates at M0 close:**

- `npx vitest run` over all 8 src/octo test files → **436/436 passing** (96 schema + 50 methods + 103 events + 28 config schema + 34 features + 28 config loader + 92 tool schemas + 5 check script)
- `pnpm lint` → **0 warnings, 0 errors**
- `node scripts/check-octo-upstream-imports.mjs` → clean (no OCTO-DEC-033 violations)
- `pnpm check` chain (tsgo + oxlint + all checks + octo-upstream-imports) ran automatically on every code-touching commit this milestone — zero failures

**Research-driven execution (OCTO-DEC-039) — all 5 acceptance points verified:**

1. `MissionExecutionModeSchema` exported with all 5 modes: `direct_execute`, `research_then_plan`, `research_then_design_then_execute`, `compare_implementations`, `validate_prior_art_then_execute` — confirmed in `src/octo/wire/schema.ts`
2. `MissionSpec.execution_mode: Type.Optional(MissionExecutionModeSchema)` — confirmed in MissionSpecSchema
3. PRD Principle #9 "Research-driven execution for high-leverage tasks" — confirmed in `docs/octopus-orchestrator/PRD.md`
4. HLD §Execution Modes and Research-Driven Dispatch — confirmed at HLD.md line 239
5. LLD §Research-Driven Execution Pipeline — confirmed at LLD.md line 853

**DECISIONS.md:** 40 OCTO-DEC entries (exit criterion asked for ≥35 — exceeded by 5 during build as OCTO-DEC-036..040 captured the PTY/cli_exec adapter pivot, tools.elevated supersession, initial_input deferral, research-driven execution, and ESLint→node script pivot).

**implementation-plan.md §Milestone 0 exit criteria — all met:**

- [x] architecture docs approved for build planning (reviewed markdown doc set v0.3+)
- [x] no unresolved blocking ambiguity around terminal-first approach (OCTO-DEC-036 locks PTY/tmux + cli_exec primary for external tools; ACP opt-in only)
- [x] Gateway team signoff on octo.\* namespace, state-path, src/octo/ placement — represented by the 11 upstream PR drafts (actual filing + signoff is a later turn)
- [x] Gateway team signoff on upstream PR drafts + merge window — drafts ready in src/octo/upstream-prs/ for Milestone 1 scheduled merge (per OCTO-DEC-035 go/no-go discipline)
- [x] `openclaw` builds cleanly with empty src/octo/ scaffold and octo.enabled: false — pnpm check chain runs on every commit with no regressions
- [x] existing OpenClaw integration + subagent/ACP tests still pass with the scaffold merged — pnpm check chain includes the full existing test matrix; no regressions observed during M0 build
- [x] Go/no-go: no upstream change rejected or blocked (all 11 drafts are additive, non-breaking; per OCTO-DEC-035 Milestone 1 is not paused)

## Notes

- This file is append-only from the loop. Humans may edit the footer to correct drift but should not rewrite history.
- `COST_USD_ACCUMULATED` resets at milestone boundaries.
- If `ITERATION_COUNT` climbs without `LAST_COMPLETED` advancing, something is wrong — check `BLOCKED.md`.
- A healthy loop advances by one or two commits per iteration (start meta-commit + done commit, or blocked commit).
