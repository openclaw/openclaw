# Octopus Orchestrator — Tasks

Agent-iteration-granularity work breakdown for Milestones 0 and 1. The Ralph loop reads this file and picks the first task whose `status: ready` and whose `depends_on` are all `status: done`. Milestones 2–5 tasks will be appended as earlier milestones complete.

**Bootstrap notes (from import into openclaw_repo-octopus at commit 9ece252):**

- All `Verify` commands in the original doc set used `npm test -- ...` assuming a vanilla npm test script. This repo's `npm test` runs a custom multi-project orchestrator (`scripts/test-projects.mjs`). The correct ad-hoc test runner is `npx vitest run <file> -t <name>`. All 38 verify commands have been rewritten. No acceptance criteria changed.
- All tasks are positioned relative to the repo root of `openclaw_repo-octopus`. The Ralph loop runs from that root.
- M0-01's original verify command included a `node -e "require(...)"` prefix that assumed CommonJS; this repo uses NodeNext with TypeScript, and vitest handles module loading directly. The prefix was removed; vitest is the single source of verify truth.

## Status legend

- `ready` — eligible for the loop to pick up
- `in_progress` — currently being worked on by a loop iteration
- `done` — acceptance criteria met and verify passed
- `blocked` — see `BLOCKED.md` for diagnosis
- `deferred` — intentionally postponed; not eligible until flipped to `ready`

## Schema

Each task has:

- **id** — stable identifier
- **Status** — see legend
- **Depends on** — list of task ids (all must be `done`)
- **Context docs** — the exact doc sections the agent must read before starting
- **Blast radius** — paths the agent is allowed to write
- **Acceptance** — objective pass criteria
- **Verify** — single shell command that exits 0 iff the task is done correctly
- **Est** — rough effort estimate for a human equivalent (not a deadline for the agent)

---

# Milestone 0 — Architecture lock + schemas + scaffold

Goal: land everything the Milestone 1 build needs to start producing runtime behavior. All M0 tasks are doc-shape or scaffold; no runtime code.

**Schema task conventions (binding for M0-01 through M0-08 and all future schema tasks):**
Lessons from the M0-01 self-critique remediation apply to every subsequent schema task in M0 and beyond. These are not optional polish — they are the expected quality bar:

1. **Strict mode everywhere.** Every `Type.Object` that represents a wire-boundary schema uses `{ additionalProperties: false }` as the second argument. Typos and unknown fields are never silently accepted.
2. **Reuse `NonEmptyString` from `src/octo/wire/primitives.ts`.** Do not re-inline `Type.String({ minLength: 1 })` for identifier fields. If a new primitive is needed (ULID, path, etc.), add it to `primitives.ts` rather than inlining it.
3. **Discriminated-union-like structures need a cross-check function.** If a schema has a union of variants tagged by a sibling field (like ArmSpec's `adapter_type` + `runtime_options`), the bare TypeBox union will not enforce the correlation. Add a `validate<Name>Spec(input)` function that runs the schema check and then cross-checks the variant against the tag. See M0-01's `validateArmSpec` for the pattern. The proper refactor to tagged unions is tracked per spec (see TODO comments + M1-14 handler task).
4. **Required-field rejection tests are parameterized.** Every required field gets its own "rejects when X is missing" test. Do not cover only one or two.
5. **`spec_version` is required and starts at 1.** All top-level wire specs (ArmSpec, GripSpec, MissionSpec, event envelopes) carry `spec_version: Type.Integer({ minimum: 1 })`. Forward compatibility is handled via the event-schema versioning framework (OCTO-DEC-018).
6. **TODO comments point at decisions.** When a schema has known-deferred work (like `initial_input` duplication per OCTO-DEC-038), leave a TODO comment in the schema file with the decision id and target milestone.

**Audit performed before M0-02 kickoff (2026-04-09):** every M0 task was reviewed against the current DECISIONS log (OCTO-DEC-001 through OCTO-DEC-038). Drift fixes applied in the same commit as this note — see SESSION-LOG for details. Two missing upstream PR tasks (M0-24, M0-25) were added; the Milestone 0 exit review was renumbered from M0-24 to M0-26.

## M0-01 — Write ArmSpec TypeBox schema

**Status:** done
**Completed:** 2026-04-09T15:43:00Z
**Depends on:** —
**Context docs:** LLD.md §Spawn Specifications (ArmSpec), DECISIONS.md OCTO-DEC-017, DECISIONS.md OCTO-DEC-036, DECISIONS.md OCTO-DEC-037
**Blast radius:** `src/octo/wire/schema.ts`, `src/octo/wire/schema.test.ts`
**Acceptance:**

- File `src/octo/wire/schema.ts` exists and exports `ArmSpecSchema` as a TypeBox `Type.Object`
- Covers every field in LLD §ArmSpec (`spec_version`, `mission_id`, `adapter_type`, `runtime_name`, `agent_id`, `desired_habitat`, `desired_capabilities`, `cwd`, `worktree_path`, `env`, `initial_input`, `policy_profile_ref`, `resource_hints`, `idempotency_key`, `labels`, `runtime_options`)
- `adapter_type` uses `Type.Union` of the four literal strings (`structured_subagent`, `cli_exec`, `pty_tmux`, `structured_acp`) — original task text said "three" but OCTO-DEC-037 added `cli_exec` as a fourth adapter type; acceptance updated to match the current architecture
- `runtime_options` is an adapter-specific discriminated union covering all four adapter types
- Test file asserts a valid ArmSpec validates and three invalid variants are rejected
  **Verify:** `npx vitest run src/octo/wire/schema.test.ts -t ArmSpec`
  **Est:** 1h

## M0-02 — Write GripSpec TypeBox schema

**Status:** done
**Completed:** 2026-04-09T16:54:00Z
**Depends on:** M0-01
**Context docs:** LLD.md §Spawn Specifications (GripSpec), LLD.md §Retry and Backoff
**Blast radius:** `src/octo/wire/schema.ts`, `src/octo/wire/schema.test.ts`
**Acceptance:**

- `GripSpecSchema` exported from `src/octo/wire/schema.ts` (same file as ArmSpec)
- Covers every LLD GripSpec field plus `spec_version`, `side_effecting`, `idempotency_key`, `retry_policy`
- `retry_policy` uses the RetryPolicy schema shape from LLD §Retry and Backoff, itself strict (`{ additionalProperties: false }`)
- **Schema conventions (see top-of-M0):** strict mode on every Type.Object, reuse `NonEmptyString` from `primitives.ts`, parameterized required-field rejection tests
- Test covers valid grip, grip with missing `idempotency_key` when `side_effecting: true` (must reject), grip with invalid retry backoff name, parameterized rejection for every required field
  **Verify:** `npx vitest run src/octo/wire/schema.test.ts -t GripSpec`
  **Est:** 1h

## M0-03 — Write MissionSpec TypeBox schema

**Status:** done
**Completed:** 2026-04-09T17:06:00Z
**Depends on:** M0-02
**Context docs:** LLD.md §Core Domain Objects (MissionRecord), LLD.md §Mission Graph Schema, LLD.md §Cost Accounting
**Blast radius:** `src/octo/wire/schema.ts`, `src/octo/wire/schema.test.ts`
**Acceptance:**

- `MissionSpecSchema` exported from `src/octo/wire/schema.ts`
- Covers `spec_version`, `title`, `owner`, `policy_profile_ref`, `metadata`, `budget`, `graph` (array of `MissionGraphNode`)
- `metadata` is a free-form `Type.Record(Type.String(), Type.Unknown())` with `maxProperties` bound; callers use keys like `source: "cron" | "flow" | "hook" | "standing_order" | "cli" | "operator"` per OCTO-DEC-014
- Graph node schema includes `grip_id`, `depends_on`, `fan_out_group`, `blocks_mission_on_failure`; strict mode; graph array has a reasonable `maxItems` bound
- Budget schema matches LLD CostRecord / Cost Accounting shape per OCTO-DEC-022: `cost_usd_limit`, `token_limit`, `on_exceed` enum (`pause` | `abort` | `warn_only`)
- **Schema conventions (see top-of-M0):** strict mode, reuse `NonEmptyString` from `primitives.ts`, parameterized required-field rejection tests, TODO-comment any fields with known-deferred work
- Test covers valid linear chain, valid fan-out, valid fan-in, cycle rejection, budget `on_exceed` enum rejection for invalid values, parameterized required-field rejection
  **Verify:** `npx vitest run src/octo/wire/schema.test.ts -t MissionSpec`
  **Est:** 1h

## M0-04 — Write octo.\* Gateway WS method schemas

**Status:** done
**Completed:** 2026-04-09T17:12:00Z
**Depends on:** M0-03
**Context docs:** HLD.md §OpenClaw Integration Foundation (Node Agent wire contract), LLD.md §Head ↔ Node Agent Wire Contract, DECISIONS.md OCTO-DEC-003
**Blast radius:** `src/octo/wire/methods.ts`, `src/octo/wire/methods.test.ts`
**Acceptance:**

- Each method in LLD §Head ↔ Node Agent Wire Contract (`octo.arm.spawn`, `octo.arm.attach`, `octo.arm.send`, `octo.arm.checkpoint`, `octo.arm.terminate`, `octo.arm.health`, `octo.node.capabilities`, `octo.node.reconcile`) has a request and response TypeBox schema
- `octo.arm.spawn` request params reuse `ArmSpecSchema` from M0-01 directly (no re-definition)
- Side-effecting methods (`spawn`, `send`, `checkpoint`, `terminate`, `reconcile`) require `idempotency_key: NonEmptyString` in params
- **Schema conventions (see top-of-M0):** strict mode on every Type.Object, reuse `NonEmptyString` from `primitives.ts`
- Test covers each method's request/response shape validation and rejection of side-effecting requests missing `idempotency_key`
  **Verify:** `npx vitest run src/octo/wire/methods.test.ts`
  **Est:** 1h

## M0-04.1 — MissionSpec execution_mode follow-up (research-driven execution)

**Status:** done
**Completed:** 2026-04-09T17:33:00Z
**Depends on:** M0-03
**Context docs:** DECISIONS.md OCTO-DEC-039, LLD.md §Research-Driven Execution Pipeline, PRD.md Principle #9, `research-driven-execution.md`
**Blast radius:** `src/octo/wire/schema.ts`, `src/octo/wire/schema.test.ts`
**Acceptance:**

- `MissionExecutionModeSchema` exported from `src/octo/wire/schema.ts` as `Type.Union` of five literals: `direct_execute`, `research_then_plan`, `research_then_design_then_execute`, `compare_implementations`, `validate_prior_art_then_execute`
- `MissionSpecSchema` extended with an **optional** `execution_mode: MissionExecutionModeSchema` field (additive, non-breaking — existing M0-03 tests continue to pass without modification)
- `MissionExecutionMode` type exported via `Static<typeof MissionExecutionModeSchema>`
- `validateMissionSpec` does NOT need updates — the execution_mode field has no cross-check because the classifier populates the graph accordingly; graph validation already handles ordering via depends_on
- Test coverage:
  - accepts a mission with each of the 5 valid execution_mode values (5 tests)
  - accepts a mission without execution_mode (default path; existing behavior preserved)
  - rejects an invalid execution_mode literal (e.g. `"yolo_execute"`)
  - rejects a mission where execution_mode is the wrong type (e.g. a number)
- **Schema conventions (see top-of-M0):** strict mode preserved, no NonEmptyString changes, parameterized pattern for mode acceptance
- This task is a follow-up to M0-03 triggered by the research-driven-execution research input (OCTO-DEC-039). It is NOT a re-open of M0-03 — M0-03 is done and its commit stands. This task adds to schema.ts without modifying M0-03's work.
  **Verify:** `npx vitest run src/octo/wire/schema.test.ts -t MissionExecutionMode`
  **Est:** 30min

## M0-05 — Write octo.\* Gateway WS event schemas

**Status:** done
**Completed:** 2026-04-09T17:50:00Z
**Depends on:** M0-04
**Context docs:** LLD.md §Event Schema, LLD.md §Head ↔ Node Agent Wire Contract
**Blast radius:** `src/octo/wire/events.ts`, `src/octo/wire/events.test.ts`
**Acceptance:**

- Each push event from LLD §Head ↔ Node Agent Wire Contract (`octo.arm.state`, `octo.arm.output`, `octo.arm.checkpoint`, `octo.lease.renew`, `octo.node.telemetry`, `octo.anomaly`) has a TypeBox schema
- Each event type from LLD §Event Schema core event types list has a payload schema — covers all five categories (arm, grip, mission, claim/lease/artifact, operator/policy)
- Base envelope schema includes `event_id` (ULID), `schema_version` (int, starts at 1, per OCTO-DEC-018), `entity_type`, `entity_id`, `event_type`, `ts` (ISO 8601), `actor`, `causation_id`, `correlation_id`, `payload`
- `entity_type` is a Type.Union of literals: `mission`, `arm`, `grip`, `claim`, `lease`, `artifact`, `operator`, `policy`
- **Schema conventions (see top-of-M0):** strict mode on envelope and all payload schemas, reuse `NonEmptyString` from `primitives.ts`, schema_version discipline per OCTO-DEC-018
- Test validates round-trip on one event of each entity type (8 tests minimum) and rejects envelopes with unknown entity_type
  **Verify:** `npx vitest run src/octo/wire/events.test.ts`
  **Est:** 1.5h

## M0-06 — Write octo: config block schema

**Status:** done
**Depends on:** —
**Context docs:** CONFIG.md (whole file)
**Blast radius:** `src/octo/config/schema.ts`, `src/octo/config/schema.test.ts`
**Acceptance:**

- `OctoConfigSchema` TypeBox schema matching the full block in CONFIG.md with all nested objects (`storage`, `events`, `lease`, `progress`, `scheduler.weights`, `quarantine`, `arm`, `retryPolicyDefault`, `cost`, `auth`, `policy`, `habitats`)
- Default values embedded in the schema
- Test validates a minimal config (just `enabled: false`), a full config with every field, and rejects three invalid configs
  **Verify:** `npx vitest run src/octo/config/schema.test.ts`
  **Est:** 1h

## M0-07 — Write features.octo structured feature descriptor

**Status:** done
**Depends on:** M0-04
**Context docs:** HLD.md §Feature advertisement via hello-ok.features.octo, INTEGRATION.md §Client feature detection
**Blast radius:** `src/octo/wire/features.ts`, `src/octo/wire/features.test.ts`
**Acceptance:**

- `FeaturesOctoSchema` exported from `src/octo/wire/features.ts` matching the JSON example in HLD §Feature advertisement
- Builder function `buildFeaturesOcto(config, adapters)` that produces a validated descriptor
- The `adapters` list includes **all four adapter types** per OCTO-DEC-037: `structured_subagent`, `cli_exec`, `pty_tmux`, `structured_acp` (original task text said "three" — updated to reflect the course correction)
- **Schema conventions (see top-of-M0):** strict mode, reuse `NonEmptyString` from `primitives.ts`
- Test covers enabled/disabled, all four adapters, adapter filtering when an adapter is unavailable, and rejection of unknown adapter names
  **Verify:** `npx vitest run src/octo/wire/features.test.ts`
  **Est:** 45min

## M0-08 — Write agent tool parameter schemas

**Status:** done
**Depends on:** M0-03, M0-04
**Context docs:** INTEGRATION.md §Agent tool surface, LLD.md §Agent tool surface, DECISIONS.md OCTO-DEC-028
**Blast radius:** `src/octo/tools/schemas.ts`, `src/octo/tools/schemas.test.ts`
**Acceptance:**

- Every read-only and writer tool listed in INTEGRATION.md §Agent tool surface has a TypeBox parameter schema (8 read-only, 8 writer, 16 total as of OCTO-DEC-028)
- Writer tool schemas all require `idempotency_key: NonEmptyString`
- Schemas are thin wrappers over `ArmSpecSchema` / `GripSpecSchema` / `MissionSpecSchema` where applicable (reuse, do not redefine)
- **Schema conventions (see top-of-M0):** strict mode, reuse `NonEmptyString` from `primitives.ts`
- Test parameterizes over all 16 tools (one valid-shape test per tool) plus rejection tests for missing `idempotency_key` on every writer tool (8 rejection tests)
  **Verify:** `npx vitest run src/octo/tools/schemas.test.ts`
  **Est:** 1h

## M0-09 — Create src/octo/ scaffold

**Status:** done
**Depends on:** —
**Context docs:** HLD.md §Code layout and module boundaries
**Blast radius:** `src/octo/**` (new directory tree only; no files outside)
**Acceptance:**

- Directory tree exactly matches HLD §Code layout (four adapter placeholders: `base.ts`, `subagent.ts`, `cli-exec.ts`, `pty-tmux.ts`, `acp.ts` — per OCTO-DEC-037 and OCTO-DEC-036)
- `src/octo/wire/` contains `primitives.ts`, `schema.ts`, `schema.test.ts` already from M0-01 and M0-01 follow-up — **do not overwrite or regenerate these files**; the scaffold only creates missing directories and placeholder READMEs, never clobbers existing files
- Each subdirectory has a placeholder `README.md` describing its purpose in one paragraph
- Top-level `src/octo/README.md` lists all subdirectories and links to this TASKS.md
- No runtime code yet — only READMEs (plus the pre-existing wire primitives/schema from M0-01)
  **Verify:** `test -d src/octo/head && test -d src/octo/adapters/openclaw && test -f src/octo/README.md && test -f src/octo/head/README.md && test -f src/octo/wire/schema.ts && test -f src/octo/wire/primitives.ts`
  **Est:** 30min

## M0-10 — Create src/octo/adapters/openclaw/ bridge header templates

**Status:** done
**Depends on:** M0-09
**Context docs:** DECISIONS.md OCTO-DEC-033, INTEGRATION.md §Upstream Dependency Classification
**Blast radius:** `src/octo/adapters/openclaw/*.ts`
**Acceptance:**

- One empty bridge file per row in INTEGRATION.md §Upstream Dependency Classification: `gateway-bridge.ts`, `sessions-spawn.ts`, `acpx-bridge.ts`, `task-ledger.ts`, `agent-config.ts`, `skills-loader.ts`, `memory-bridge.ts`, `presence-bridge.ts`, `taskflow-bridge.ts`, `features-advertiser.ts`
- Each file has a header comment with these fields filled: `Wraps:`, `Tested against OpenClaw:`, `Stable assumptions:`, `Reach-arounds:`, `Rollback plan:`
- `acpx-bridge.ts` header must explicitly note **opt-in only per OCTO-DEC-036** — never the default path for external coding tools
- Bodies are empty placeholders that export a `NotImplemented` symbol
  **Verify:** `for f in src/octo/adapters/openclaw/*.ts; do grep -q 'Wraps:' "$f" && grep -q 'Tested against OpenClaw:' "$f" || exit 1; done && grep -q 'OCTO-DEC-036' src/octo/adapters/openclaw/acpx-bridge.ts`
  **Est:** 45min

## M0-11 — Add octo.enabled feature flag to config loader

**Status:** done
**Depends on:** M0-06
**Context docs:** DECISIONS.md OCTO-DEC-027, CONFIG.md §Feature flag
**Blast radius:** `src/octo/config/loader.ts`, `src/octo/config/loader.test.ts` — **no changes to existing OpenClaw config loader outside `src/octo/`**
**Acceptance:**

- `loadOctoConfig()` reads the `octo:` block from `openclaw.json` and returns a validated config object
- Default to `{ enabled: false }` if the block is missing
- Logs a single info line on startup indicating the resolved `enabled` state
- Test covers: missing block, minimal `{ enabled: true }` block, full block with overrides
  **Verify:** `npx vitest run src/octo/config/loader.test.ts`
  **Est:** 45min

## M0-12 — Add lint rule preventing OpenClaw internal imports from outside adapters/openclaw/

**Status:** done
**Depends on:** M0-10
**Context docs:** DECISIONS.md OCTO-DEC-033
**Blast radius:** `.eslintrc.octo.js`, `src/octo/.eslintrc.js`
**Acceptance:**

- ESLint config rejects imports from OpenClaw internal paths (everything outside `src/octo/` in the OpenClaw source tree) from any file in `src/octo/**` that is not in `src/octo/adapters/openclaw/**`
- Test: a fixture file at `src/octo/test-fixtures/bad-import.ts.fixture` that imports from `../../gateway/server-methods-list` must be flagged by `eslint` and the CI script exits non-zero
- A matching fixture inside `adapters/openclaw/` with the same import is allowed
  **Verify:** `node scripts/check-octo-upstream-imports.mjs && npx vitest run test/scripts/check-octo-upstream-imports.test.ts` (pivoted from ESLint to bespoke node script per OCTO-DEC-040)
  **Est:** 1h

## M0-13 — CI check enforcing the lint rule

**Status:** done
**Depends on:** M0-12
**Context docs:** (same as M0-12)
**Blast radius:** `src/octo/ci/lint-check.sh`, `.github/workflows/octo-lint.yml` (or existing CI equivalent)
**Acceptance:**

- A script in `src/octo/ci/lint-check.sh` runs the ESLint rule across `src/octo/**` and exits non-zero on any violation
- CI workflow invokes this script on every PR touching `src/octo/**`
- Running the script on the current clean tree passes
  **Verify:** `bash src/octo/ci/lint-check.sh`
  **Est:** 30min

## M0-14 — Create COMPATIBILITY.md stub

**Status:** done
**Depends on:** —
**Context docs:** INTEGRATION.md §Upstream Compatibility Matrix, DECISIONS.md OCTO-DEC-034
**Blast radius:** `docs/octopus-orchestrator/COMPATIBILITY.md` (human-reviewed exception — this file is created by the loop but then marked read-only)
**Acceptance:**

- File exists with header, a table for `Supported minimum`, `Known working`, `Floor reason`, `Last test run`
- Initial values: minimum set to the currently installed OpenClaw version (`openclaw --version` output), known working same, floor reason "M0 baseline", last test run dated today
- Human-review marker comment at top: `<!-- This file is human-reviewed after M0-14 completes. Do not modify from loop runs. -->`
  **Verify:** `test -f docs/octopus-orchestrator/COMPATIBILITY.md && grep -q 'Supported minimum' docs/octopus-orchestrator/COMPATIBILITY.md`
  **Est:** 20min

## M0-15 — Draft upstream PR 1: register octo.\* methods in server-methods-list

**Status:** done
**Depends on:** M0-04
**Context docs:** INTEGRATION.md §Required Upstream Changes, INTEGRATION.md §Feature advertisement
**Blast radius:** `src/octo/upstream-prs/PR-01-server-methods-list.md`, `src/octo/upstream-prs/PR-01.patch`
**Acceptance:**

- Markdown draft describing the change, rationale, expected file path in OpenClaw (`src/gateway/server-methods-list.ts` per INTEGRATION.md), and diff preview
- A patch file that, when applied to a hypothetical OpenClaw clone, would register the method names exported by `src/octo/wire/methods.ts`
- Does NOT attempt to actually apply the patch
  **Verify:** `test -f src/octo/upstream-prs/PR-01-server-methods-list.md && test -f src/octo/upstream-prs/PR-01.patch`
  **Est:** 45min

## M0-16 — Draft upstream PR 2: features.octo advertiser

**Status:** done
**Depends on:** M0-07, M0-15
**Context docs:** (same)
**Blast radius:** `src/octo/upstream-prs/PR-02-features-advertiser.md`, `src/octo/upstream-prs/PR-02.patch`
**Acceptance:** parallel to M0-15 for the features.octo builder integration
**Verify:** `test -f src/octo/upstream-prs/PR-02-features-advertiser.md && test -f src/octo/upstream-prs/PR-02.patch`
**Est:** 30min

## M0-17 — Draft upstream PR 3: accept caps.octo on role: node connect

**Status:** done
**Depends on:** M0-15
**Context docs:** (same)
**Blast radius:** `src/octo/upstream-prs/PR-03-caps-octo-connect.md`, `src/octo/upstream-prs/PR-03.patch`
**Acceptance:** parallel
**Verify:** `test -f src/octo/upstream-prs/PR-03-caps-octo-connect.md && test -f src/octo/upstream-prs/PR-03.patch`
**Est:** 30min

## M0-18 — Draft upstream PR 4: /octo slash command dispatch

**Status:** done
**Depends on:** M0-15
**Context docs:** INTEGRATION.md §In-chat operator surface
**Blast radius:** `src/octo/upstream-prs/PR-04-octo-slash.md`, `src/octo/upstream-prs/PR-04.patch`
**Acceptance:** parallel
**Verify:** `test -f src/octo/upstream-prs/PR-04-octo-slash.md && test -f src/octo/upstream-prs/PR-04.patch`
**Est:** 30min

## M0-19 — Draft upstream PR 5: cron job type octo.mission

**Status:** done
**Depends on:** M0-15
**Context docs:** INTEGRATION.md §Automation trigger surfaces
**Blast radius:** `src/octo/upstream-prs/PR-05-cron-octo-mission.md`, `src/octo/upstream-prs/PR-05.patch`
**Acceptance:** parallel
**Verify:** `test -f src/octo/upstream-prs/PR-05-cron-octo-mission.md && test -f src/octo/upstream-prs/PR-05.patch`
**Est:** 30min

## M0-20 — Draft upstream PR 6: Task Flow step type + mirrored observer

**Status:** done
**Depends on:** M0-15
**Context docs:** INTEGRATION.md §Task Flow (formerly ClawFlow), DECISIONS.md OCTO-DEC-030
**Blast radius:** `src/octo/upstream-prs/PR-06-taskflow-mirrored.md`, `src/octo/upstream-prs/PR-06.patch`
**Acceptance:** parallel
**Verify:** `test -f src/octo/upstream-prs/PR-06-taskflow-mirrored.md && test -f src/octo/upstream-prs/PR-06.patch`
**Est:** 45min

## M0-21 — Draft upstream PR 7: hook handler octo.mission.create

**Status:** done
**Depends on:** M0-15
**Context docs:** (same)
**Blast radius:** `src/octo/upstream-prs/PR-07-hook-handler.md`, `src/octo/upstream-prs/PR-07.patch`
**Acceptance:** parallel
**Verify:** `test -f src/octo/upstream-prs/PR-07-hook-handler.md && test -f src/octo/upstream-prs/PR-07.patch`
**Est:** 30min

## M0-22 — Draft upstream PR 8: openclaw octo CLI dispatch

**Status:** done
**Depends on:** M0-15
**Context docs:** LLD.md §Operator Surfaces
**Blast radius:** `src/octo/upstream-prs/PR-08-octo-cli.md`, `src/octo/upstream-prs/PR-08.patch`
**Acceptance:** parallel
**Verify:** `test -f src/octo/upstream-prs/PR-08-octo-cli.md && test -f src/octo/upstream-prs/PR-08.patch`
**Est:** 30min

## M0-23 — Draft upstream PR 9: agent tool registration for octo\_\* tools

**Status:** done
**Depends on:** M0-08, M0-15
**Context docs:** INTEGRATION.md §Agent tool surface, DECISIONS.md OCTO-DEC-028
**Blast radius:** `src/octo/upstream-prs/PR-09-agent-tools.md`, `src/octo/upstream-prs/PR-09.patch`
**Acceptance:** parallel
**Verify:** `test -f src/octo/upstream-prs/PR-09-agent-tools.md && test -f src/octo/upstream-prs/PR-09.patch`
**Est:** 45min

## M0-24 — Draft upstream PR 10: octo.writer device token capability

**Status:** done
**Depends on:** M0-15, M0-17
**Context docs:** INTEGRATION.md §Required Upstream Changes (row 4), INTEGRATION.md §Operator authorization model, DECISIONS.md OCTO-DEC-024, DECISIONS.md OCTO-DEC-029
**Blast radius:** `src/octo/upstream-prs/PR-10-octo-writer-capability.md`, `src/octo/upstream-prs/PR-10.patch`
**Acceptance:**

- Markdown draft describing the change: recognize `octo.writer` as a capability on device tokens, gate side-effecting `octo.*` methods behind it, auto-grant on loopback per OCTO-DEC-024
- Expected file paths in OpenClaw core (`src/gateway/pairing.ts` or equivalent per INTEGRATION.md row 4)
- Explicit statement that this is distinct from `tools.elevated` which is sandbox breakout for exec (OCTO-DEC-029)
- Patch file that, when applied to a hypothetical OpenClaw clone, would register the capability
- Does NOT attempt to actually apply the patch
  **Verify:** `test -f src/octo/upstream-prs/PR-10-octo-writer-capability.md && test -f src/octo/upstream-prs/PR-10.patch`
  **Est:** 45min

## M0-25 — Draft upstream PR 11: octo.enabled config block loader integration

**Status:** done
**Depends on:** M0-11, M0-15
**Context docs:** INTEGRATION.md §Required Upstream Changes (row 9), CONFIG.md §Feature flag, DECISIONS.md OCTO-DEC-027
**Blast radius:** `src/octo/upstream-prs/PR-11-octo-enabled-config.md`, `src/octo/upstream-prs/PR-11.patch`
**Acceptance:**

- Markdown draft describing the change: make OpenClaw's core config loader aware of the new `octo:` config block, dispatch to `loadOctoConfig()` from `src/octo/config/loader.ts` when present
- Explicit statement that `octo.enabled: false` (default) is a full no-op — no state paths created, no `octo.*` methods registered, no CLI dispatch
- Expected file paths in OpenClaw core (`src/config/schema.ts` or equivalent per INTEGRATION.md row 9)
- Patch file that, when applied to a hypothetical OpenClaw clone, would wire `loadOctoConfig` into the core config loader's startup flow
- Does NOT attempt to actually apply the patch
  **Verify:** `test -f src/octo/upstream-prs/PR-11-octo-enabled-config.md && test -f src/octo/upstream-prs/PR-11.patch`
  **Est:** 45min

## M0-26 — Milestone 0 exit review

**Status:** done
**Depends on:** M0-01, M0-02, M0-03, M0-04, M0-04.1, M0-05, M0-06, M0-07, M0-08, M0-09, M0-10, M0-11, M0-12, M0-13, M0-14, M0-15, M0-16, M0-17, M0-18, M0-19, M0-20, M0-21, M0-22, M0-23, M0-24, M0-25
**Context docs:** implementation-plan.md §Milestone 0, DECISIONS.md OCTO-DEC-039
**Blast radius:** `docs/octopus-orchestrator/STATE.md`, `docs/octopus-orchestrator/SESSION-LOG.md`
**Acceptance:**

- Every M0 task (including M0-04.1) is `status: done`
- Every exit criterion in `implementation-plan.md §Milestone 0` is checkable
- All 11 upstream PR drafts exist and their acceptance criteria hold
- MissionSpec includes the `execution_mode` field per OCTO-DEC-039, and `MissionExecutionModeSchema` is exported with all 5 modes
- PRD Principle #9 (Research-driven execution) is present in PRD.md
- HLD §Execution Modes and Research-Driven Dispatch section is present
- LLD §Research-Driven Execution Pipeline section is present
- `STATE.md` updated with `MILESTONE_0_COMPLETE` marker
- `SESSION-LOG.md` appended with M0 completion summary including a full audit of what M0-02 through M0-25 (plus M0-04.1) actually delivered vs their acceptance criteria
  **Verify:** `grep -q 'MILESTONE_0_COMPLETE' docs/octopus-orchestrator/STATE.md`
  **Est:** 30min

---

# Milestone 1 — Local Octopus MVP (tmux-backed arms, registry, event log, CLI)

Goal: prove durable local arm orchestration on one machine. All tasks below are net-new runtime code.

## M1-01 — SQLite schema bootstrap

**Status:** done
**Depends on:** M0-26
**Context docs:** LLD.md §Storage Choices, LLD.md §Core Domain Objects
**Blast radius:** `src/octo/head/storage/schema.sql`, `src/octo/head/storage/migrate.ts`, `src/octo/head/storage/migrate.test.ts`
**Acceptance:**

- SQL schema defines tables for `missions`, `arms`, `grips`, `claims`, `leases`, `artifacts` with columns matching the LLD fields
- Every mutable table has a `version INTEGER NOT NULL DEFAULT 0` column for CAS
- `migrate.ts` creates the schema on first run at `~/.openclaw/octo/registry.sqlite`
- Test creates a temp DB, applies the schema, inserts a row, reads it back
  **Verify:** `npx vitest run src/octo/head/storage/migrate.test.ts`
  **Est:** 1.5h

## M1-02 — RegistryService with CAS semantics

**Status:** done
**Depends on:** M1-01
**Context docs:** LLD.md §Control Plane Services (RegistryService), DECISIONS.md OCTO-DEC-010
**Blast radius:** `src/octo/head/registry.ts`, `src/octo/head/registry.test.ts`
**Acceptance:**

- `RegistryService` class with `getArm`, `putArm`, `listArms`, `casUpdateArm(arm_id, expectedVersion, patch)` and parallel methods for missions, grips, claims
- `casUpdate*` methods throw `ConflictError` when the version does not match
- Test: concurrent casUpdate attempts — exactly one wins
  **Verify:** `npx vitest run src/octo/head/registry.test.ts`
  **Est:** 2h

## M1-03 — EventLogService: append + base envelope

**Status:** done
**Depends on:** M0-05, M1-01
**Context docs:** LLD.md §Event Schema, LLD.md §Event Schema Versioning and Migration
**Blast radius:** `src/octo/head/event-log.ts`, `src/octo/head/event-log.test.ts`
**Acceptance:**

- `EventLogService.append(event)` writes a validated event to `~/.openclaw/octo/events.jsonl`
- Generates `event_id` as ULID
- Rejects events that fail TypeBox validation
- Test: append 100 events, verify file line count and ULID monotonicity
  **Verify:** `npx vitest run src/octo/head/event-log.test.ts -t append`
  **Est:** 1h

## M1-04 — EventLogService: replay

**Status:** done
**Depends on:** M1-03
**Context docs:** LLD.md §Event Schema Versioning and Migration
**Blast radius:** `src/octo/head/event-log.ts`, `src/octo/head/event-log.test.ts`
**Acceptance:**

- `EventLogService.replay(handler)` reads the event log line by line and calls the handler for each event in ULID order
- Honors schema_version — calls the migration transform for older events before passing to the handler
- Test: write events with two schema versions, verify replay produces the canonical representation
  **Verify:** `npx vitest run src/octo/head/event-log.test.ts -t replay`
  **Est:** 1.5h

## M1-05 — EventLogService: schema version migration framework

**Status:** done
**Depends on:** M1-04
**Context docs:** LLD.md §Event Schema Versioning and Migration, DECISIONS.md OCTO-DEC-018
**Blast radius:** `src/octo/head/event-log-migrations.ts`, `src/octo/head/event-log-migrations.test.ts`
**Acceptance:**

- Migration table `migrations: Record<number, (event) => event>` that upgrades events across versions
- Pure, total functions — never throw on any historical input
- Test: register a mock v1→v2 migration, replay a log with mixed versions, verify all events come out at v2
  **Verify:** `npx vitest run src/octo/head/event-log-migrations.test.ts`
  **Est:** 1h

## M1-06 — EventLogService: tail

**Status:** done
**Depends on:** M1-03
**Context docs:** LLD.md §Operator Surfaces (events --tail)
**Blast radius:** `src/octo/head/event-log.ts`, `src/octo/head/event-log.test.ts`
**Acceptance:**

- `EventLogService.tail(filter, handler)` streams new events as they are appended
- Filter supports entity_type, entity_id, event_type
- Test: start tail, append 10 events, verify handler receives the filtered subset
  **Verify:** `npx vitest run src/octo/head/event-log.test.ts -t tail`
  **Est:** 1.5h

## M1-07 — ArmRecord state machine

**Status:** done
**Depends on:** M1-02
**Context docs:** LLD.md §State Machines (Arm state machine)
**Blast radius:** `src/octo/head/arm-fsm.ts`, `src/octo/head/arm-fsm.test.ts`
**Acceptance:**

- `validArmTransition(from, to): boolean` function matches the LLD state diagram exactly
- `applyArmTransition(arm, to)` returns the updated arm or throws `InvalidTransitionError`
- Test: every valid transition returns ok, every invalid transition throws
  **Verify:** `npx vitest run src/octo/head/arm-fsm.test.ts`
  **Est:** 1h

## M1-08 — GripRecord state machine

**Status:** done
**Depends on:** M1-02
**Context docs:** LLD.md §State Machines (Grip state machine)
**Blast radius:** `src/octo/head/grip-fsm.ts`, `src/octo/head/grip-fsm.test.ts`
**Acceptance:** parallel to M1-07 for grips
**Verify:** `npx vitest run src/octo/head/grip-fsm.test.ts`
**Est:** 45min

## M1-09 — MissionRecord state machine

**Status:** done
**Depends on:** M1-02
**Context docs:** LLD.md §Core Domain Objects (MissionRecord status enum)
**Blast radius:** `src/octo/head/mission-fsm.ts`, `src/octo/head/mission-fsm.test.ts`
**Acceptance:** parallel, covers `active`, `paused`, `completed`, `aborted`, `archived`
**Verify:** `npx vitest run src/octo/head/mission-fsm.test.ts`
**Est:** 45min

## M1-10 — TmuxManager: create + list + kill

**Status:** done
**Depends on:** —
**Context docs:** LLD.md §Node Agent Internals (TmuxManager), HLD.md §tmux as a Foundational Substrate
**Blast radius:** `src/octo/node-agent/tmux-manager.ts`, `src/octo/node-agent/tmux-manager.test.ts`
**Acceptance:**

- `createSession(name, cmd, cwd)` spawns a detached tmux session and returns its name
- `listSessions()` returns an array of live tmux session names
- `killSession(name)` terminates a session and returns true on success
- Test (requires tmux installed): create, list includes the session, kill, list no longer includes it
  **Verify:** `which tmux && npx vitest run src/octo/node-agent/tmux-manager.test.ts`
  **Est:** 1.5h

## M1-11 — TmuxManager: enumerate pre-existing sessions (for reconciliation)

**Status:** done
**Depends on:** M1-10
**Context docs:** LLD.md §Node Agent Internals (SessionReconciler)
**Blast radius:** `src/octo/node-agent/tmux-manager.ts`, `src/octo/node-agent/tmux-manager.test.ts`
**Acceptance:**

- `enumerateExisting()` returns tmux sessions present at startup, including sessions not created by this process
- Returns structured info: name, created_ts (best effort), cwd
  **Verify:** `npx vitest run src/octo/node-agent/tmux-manager.test.ts -t enumerate`
  **Est:** 45min

## M1-12 — ProcessWatcher

**Status:** done
**Depends on:** M1-10
**Context docs:** LLD.md §Node Agent Internals (ProcessWatcher), LLD.md §Recovery Flows §3
**Blast radius:** `src/octo/node-agent/process-watcher.ts`, `src/octo/node-agent/process-watcher.test.ts`
**Acceptance:**

- Watches a tmux session for process exit
- Emits `arm.failed` event with exit reason when the pane process exits non-zero
- Test: start a session running `exit 7`, verify event is emitted with the exit code
  **Verify:** `npx vitest run src/octo/node-agent/process-watcher.test.ts`
  **Est:** 1.5h

## M1-13 — SessionReconciler on startup

**Status:** done
**Depends on:** M1-11, M1-07, M1-02
**Context docs:** LLD.md §SessionReconciler behavior, LLD.md §Recovery Flows §2
**Blast radius:** `src/octo/node-agent/session-reconciler.ts`, `src/octo/node-agent/session-reconciler.test.ts`
**Acceptance:**

- On startup, enumerate live tmux sessions and compare against persisted ArmRecords
- Emit `arm.recovered` for matching sessions
- Emit `anomaly` for orphaned sessions or missing expected sessions
- Test: create a tmux session matching a persisted arm id, run reconciler, verify recovery event
  **Verify:** `npx vitest run src/octo/node-agent/session-reconciler.test.ts`
  **Est:** 2h

## M1-14 — octo.arm.spawn Gateway WS handler (stub adapter)

**Status:** done
**Depends on:** M1-02, M1-07, M1-10, M0-04
**Context docs:** LLD.md §Head ↔ Node Agent Wire Contract
**Blast radius:** `src/octo/wire/gateway-handlers.ts`, `src/octo/wire/gateway-handlers.test.ts`
**Acceptance:**

- `octo.arm.spawn` handler validates the ArmSpec, inserts ArmRecord via RegistryService, emits `arm.created` and `arm.starting` events, calls a stub PtyTmuxAdapter that just creates a tmux session
- Returns SessionRef with tmux session name
- Test: valid spawn request produces the expected arm row + events
  **Verify:** `npx vitest run src/octo/wire/gateway-handlers.test.ts -t spawn`
  **Est:** 2h

## M1-15 — octo.arm.health handler

**Status:** done
**Depends on:** M1-14
**Context docs:** (same)
**Blast radius:** `src/octo/wire/gateway-handlers.ts`, `src/octo/wire/gateway-handlers.test.ts`
**Acceptance:** returns structured health snapshot for an arm id; unknown arm returns structured error
**Verify:** `npx vitest run src/octo/wire/gateway-handlers.test.ts -t health`
**Est:** 45min

## M1-16 — octo.arm.terminate handler

**Status:** done
**Depends on:** M1-14
**Context docs:** (same)
**Blast radius:** `src/octo/wire/gateway-handlers.ts`, `src/octo/wire/gateway-handlers.test.ts`
**Acceptance:** terminates tmux session, transitions arm to `terminated`, emits event, writes reason to event payload
**Verify:** `npx vitest run src/octo/wire/gateway-handlers.test.ts -t terminate`
**Est:** 45min

## M1-17 — CLI: openclaw octo status

**Status:** done
**Depends on:** M1-02
**Context docs:** LLD.md §Operator Surfaces
**Blast radius:** `src/octo/cli/status.ts`, `src/octo/cli/status.test.ts`
**Acceptance:**

- Human default: single-screen dashboard
- `--json`: structured snapshot
- Returns exit 0 with empty state, not an error
  **Verify:** `npx vitest run src/octo/cli/status.test.ts`
  **Est:** 1h

## M1-18 — CLI: openclaw octo arm list

**Status:** done
**Depends on:** M1-17
**Context docs:** (same)
**Blast radius:** `src/octo/cli/arm-list.ts`, `src/octo/cli/arm-list.test.ts`
**Acceptance:** lists arms with filters `--mission`, `--node`, `--state`, `--json`
**Verify:** `npx vitest run src/octo/cli/arm-list.test.ts`
**Est:** 45min

## M1-19 — CLI: openclaw octo arm show

**Status:** done
**Depends on:** M1-17
**Context docs:** (same)
**Blast radius:** `src/octo/cli/arm-show.ts`, `src/octo/cli/arm-show.test.ts`
**Acceptance:** prints arm detail including state, lease, current grip, last 20 events
**Verify:** `npx vitest run src/octo/cli/arm-show.test.ts`
**Est:** 45min

## M1-20 — CLI: openclaw octo arm attach

**Status:** done
**Depends on:** M1-10, M1-17
**Context docs:** (same)
**Blast radius:** `src/octo/cli/arm-attach.ts`, `src/octo/cli/arm-attach.test.ts`
**Acceptance:** execs `tmux attach -t <session name>` for the arm's session; handles detach cleanly
**Verify:** `npx vitest run src/octo/cli/arm-attach.test.ts`
**Est:** 45min

## M1-21 — CLI: openclaw octo arm restart

**Status:** done
**Depends on:** M1-16, M1-14
**Context docs:** (same)
**Blast radius:** `src/octo/cli/arm-restart.ts`, `src/octo/cli/arm-restart.test.ts`
**Acceptance:** terminates current session, respawns with same ArmSpec, preserves arm_id, increments restart_count
**Verify:** `npx vitest run src/octo/cli/arm-restart.test.ts`
**Est:** 1h

## M1-22 — CLI: openclaw octo arm terminate

**Status:** done
**Depends on:** M1-16
**Context docs:** (same)
**Blast radius:** `src/octo/cli/arm-terminate.ts`, `src/octo/cli/arm-terminate.test.ts`
**Acceptance:** terminates arm with `--reason <text>`, non-zero exit if arm id unknown
**Verify:** `npx vitest run src/octo/cli/arm-terminate.test.ts`
**Est:** 30min

## M1-23 — CLI: openclaw octo events --tail

**Status:** done
**Depends on:** M1-06
**Context docs:** (same)
**Blast radius:** `src/octo/cli/events-tail.ts`, `src/octo/cli/events-tail.test.ts`
**Acceptance:** streams events, `--entity`, `--type`, `--json` filters work
**Verify:** `npx vitest run src/octo/cli/events-tail.test.ts`
**Est:** 1h

## M1-24 — Metric instrumentation: arm and event-log metrics

**Status:** done
**Depends on:** M1-14, M1-03
**Context docs:** OBSERVABILITY.md §Arm metrics, §Event log metrics
**Blast radius:** `src/octo/head/metrics.ts`, `src/octo/head/metrics.test.ts`
**Acceptance:**

- Emits `openclaw_octo_arms_active`, `openclaw_octo_arms_idle`, `openclaw_octo_arm_spawn_duration_seconds`, `openclaw_octo_arm_restarts_total`, `openclaw_octo_events_written_total`, `openclaw_octo_event_log_bytes`
- Uses the existing OpenClaw metrics framework (feature-detect at load time)
  **Verify:** `npx vitest run src/octo/head/metrics.test.ts`
  **Est:** 1.5h

## M1-25 — Chaos test: kill local arm process

**Status:** done
**Depends on:** M1-12, M1-13, M1-14
**Context docs:** TEST-STRATEGY.md §Chaos tests (M1 row 1)
**Blast radius:** `src/octo/test/chaos/kill-arm-process.test.ts`
**Acceptance:**

- Spawn an arm, kill its underlying process, assert detection within 60s, assert restart count incremented, assert state visible via CLI
  **Verify:** `npx vitest run src/octo/test/chaos/kill-arm-process.test.ts`
  **Est:** 2h

## M1-26 — Chaos test: kill Gateway process during active arms

**Status:** done
**Depends on:** M1-13, M1-04
**Context docs:** TEST-STRATEGY.md §Chaos tests (M1 row 2)
**Blast radius:** `src/octo/test/chaos/kill-gateway.test.ts`
**Acceptance:**

- Spawn arms, kill Gateway, restart, assert replay reconstructs correct state, assert no duplicate execution
  **Verify:** `npx vitest run src/octo/test/chaos/kill-gateway.test.ts`
  **Est:** 2h

## M1-27 — Chaos test: disk fill on events.jsonl partition

**Status:** done
**Depends on:** M1-03
**Context docs:** TEST-STRATEGY.md §Chaos tests (M1 row 3)
**Blast radius:** `src/octo/test/chaos/disk-fill.test.ts`
**Acceptance:**

- Simulate disk fill, assert head enters degraded state, assert anomaly emitted, assert no log corruption
  **Verify:** `npx vitest run src/octo/test/chaos/disk-fill.test.ts`
  **Est:** 1.5h

## M1-28 — Integration test: spawn-10-arms-under-30s (PRD success metric)

**Status:** done
**Depends on:** M1-14
**Context docs:** PRD.md §Success Metrics, TEST-STRATEGY.md §Success metric validation
**Blast radius:** `src/octo/test/integration/spawn-10-arms.test.ts`
**Acceptance:**

- Spawn 10 arms concurrently, assert all reach `arm.active` within 30s wall clock
  **Verify:** `npx vitest run src/octo/test/integration/spawn-10-arms.test.ts`
  **Est:** 1h

## M1-29 — openclaw octo doctor

**Status:** done
**Depends on:** M1-01, M1-03, M1-10
**Context docs:** INTEGRATION.md §First-run and doctor
**Blast radius:** `src/octo/cli/doctor.ts`, `src/octo/cli/doctor.test.ts`
**Acceptance:**

- Checks: feature flag state, state path writability, SQLite registry health, event log integrity, tmux availability, default agent ceiling permissiveness
- Structured diagnostic output with severity classification
- Idempotent, read-only
  **Verify:** `npx vitest run src/octo/cli/doctor.test.ts`
  **Est:** 1.5h

## M1-30 — Milestone 1 exit review

**Status:** done
**Depends on:** M1-01 through M1-29
**Context docs:** implementation-plan.md §Milestone 1
**Blast radius:** `docs/octopus-orchestrator/STATE.md`, `docs/octopus-orchestrator/SESSION-LOG.md`
**Acceptance:**

- Every M1 task `done`
- All M1 chaos tests pass
- PRD success metric `spawn-10-arms-under-30s` passes
- `STATE.md` appended with `MILESTONE_1_COMPLETE` marker
  **Verify:** `grep -q 'MILESTONE_1_COMPLETE' docs/octopus-orchestrator/STATE.md`
  **Est:** 30min

---

---

# Milestone 2 — Runtime Adapters (Structured + PTY + Bridge Integration)

Goal: land the adapter interface and all four adapter implementations so subagent, cli_exec, pty_tmux, and structured_acp sessions all appear as first-class arms. Wire the Node Agent runtime loop. Fill the OpenClaw bridge files. Pass the First-Class Citizenship Checklist.

## Top-of-M2 conventions (binding for all M2 tasks)

All M0/M1 conventions carry forward (strict mode, NonEmptyString reuse, parameterized tests, commit-every-turn, etc.) plus:

- **Adapter contract compliance:** every adapter MUST implement the full `Adapter` interface from M2-01. No partial implementations — if a method is not semantically meaningful for an adapter type, it still exists and throws a structured `AdapterError("not_supported", ...)`.
- **Event normalization:** every adapter emits events through the `EventNormalizer` from M2-02. Raw adapter-specific output shapes are NEVER leaked to the Head.
- **Bridge discipline (OCTO-DEC-033):** SubagentAdapter and AcpAdapter consume OpenClaw internals ONLY through the bridge files in `src/octo/adapters/openclaw/`. Bridge files export typed interfaces + a real implementation that uses dynamic imports (so the bridge degrades gracefully when OpenClaw internals are absent during isolated testing). Tests use mocks injected via the interface.
- **Verification quad-gate:** every agent runs `npx vitest run <file>` + `pnpm lint` + `npx tsgo -p tsconfig.json` + `node scripts/check-octo-upstream-imports.mjs` before reporting done. All four must be clean. tsgo is non-negotiable.
- **Schema-trumps-brief:** if the agent prompt disagrees with actual TypeBox schemas in `src/octo/wire/`, the schema wins. Adjust without asking; report the discrepancy.
- **Tmux session cleanup:** any test that creates tmux sessions must use per-run prefix discipline and sweep in afterEach + afterAll. Zero leaked sessions.

## M2-01 — Adapter interface + base types

**Status:** done
**Depends on:** M1-14
**Context docs:** LLD.md §Runtime Adapter Interfaces (line 335), LLD.md §Adapter mapping and preference order
**Blast radius:** `src/octo/adapters/base.ts` (overwrite M0-09 placeholder), `src/octo/adapters/base.test.ts`
**Acceptance:**

- `Adapter` interface with all 7 methods per LLD: `spawn(spec) -> SessionRef`, `resume(ref) -> SessionRef`, `send(ref, message)`, `stream(ref) -> AsyncIterable<AdapterEvent>`, `checkpoint(ref) -> CheckpointMeta`, `terminate(ref)`, `health(ref) -> HealthStatus`
- `AdapterError` extends Error with `code: "not_supported" | "spawn_failed" | "session_not_found" | "send_failed" | "terminated" | "internal"`
- `CheckpointMeta` type exported (pid/elapsed/byte count/progress markers)
- `AdapterType` enum reused from `wire/schema.ts` (not redeclared)
- Test: a mock adapter implementing the interface compiles and round-trips through every method
  **Verify:** `npx vitest run src/octo/adapters/base.test.ts`
  **Est:** 45min

## M2-02 — Event normalization types + pipeline

**Status:** done
**Depends on:** M2-01
**Context docs:** LLD.md §Runtime Adapter Interfaces (output normalization), HLD.md §Adapter layer
**Blast radius:** `src/octo/adapters/event-normalizer.ts`, `src/octo/adapters/event-normalizer.test.ts`
**Acceptance:**

- `AdapterEvent` discriminated union: `output_chunk | state_transition | cost_metadata | error | completion`
- `EventNormalizer` class validates incoming adapter events, stamps them with arm_id/ts/sequence, and converts to EventEnvelope-compatible records for the Head
- Rejects malformed events without crashing the adapter (returns an anomaly record instead)
- Test: valid events normalize correctly; malformed events produce anomaly records; sequence numbers are monotonic
  **Verify:** `npx vitest run src/octo/adapters/event-normalizer.test.ts`
  **Est:** 1h

## M2-03 — Node Agent runtime loop

**Status:** done
**Depends on:** M1-10, M1-12, M1-13, M1-14, M2-01
**Context docs:** LLD.md §Node Agent Internals (line 522), HLD.md §Node Agent Lifecycle
**Blast radius:** `src/octo/node-agent/agent.ts`, `src/octo/node-agent/agent.test.ts`
**Acceptance:**

- `NodeAgent` class composing TmuxManager + ProcessWatcher + SessionReconciler + adapter dispatcher into a running event loop
- Startup: reconcile existing sessions → start ProcessWatcher for each active arm → begin polling loop
- The `starting → active` liveness transition that M1 was missing: when an adapter reports the session is alive and healthy, the agent drives the FSM transition and emits `arm.active`
- `stop()` cleanly shuts down the loop and all watchers
- Test: spawn an arm, start the agent, assert the arm transitions from `starting` to `active` within 5s; stop the agent cleanly
  **Verify:** `npx vitest run src/octo/node-agent/agent.test.ts`
  **Est:** 2h

## M2-04 — Adapter dispatcher (factory + arm.spawn routing)

**Status:** done
**Depends on:** M2-01, M2-02
**Context docs:** LLD.md §Adapter mapping and preference order
**Blast radius:** `src/octo/adapters/factory.ts`, `src/octo/adapters/factory.test.ts`, `src/octo/wire/gateway-handlers.ts` (modify)
**Acceptance:**

- `createAdapter(adapterType, deps): Adapter` factory function
- `arm.spawn` handler refactored to route through the factory instead of directly calling TmuxManager
- M1's "pty_tmux only" stub gate removed — all 4 adapter types accepted (with cli_exec, subagent, acp routing to their respective adapters once those tasks land; until then the factory throws `AdapterError("not_supported")` for unimplemented types)
- Test: factory creates the right adapter for each type; arm.spawn routes through the factory
  **Verify:** `npx vitest run src/octo/adapters/factory.test.ts && npx vitest run src/octo/wire/gateway-handlers.test.ts -t spawn`
  **Est:** 1h

## M2-05 — CliExecAdapter: spawn + process lifecycle

**Status:** done
**Depends on:** M2-01, M2-02
**Context docs:** LLD.md §CliExecAdapter (around line 394), DECISIONS.md OCTO-DEC-037
**Blast radius:** `src/octo/adapters/cli-exec.ts`, `src/octo/adapters/cli-exec.test.ts`
**Acceptance:**

- `spawn(spec)` via `child_process.spawn` with args array, cwd, env merge. No PTY, no tmux — raw subprocess
- Exit detection via ChildProcess `exit` event with exit code capture
- `terminate(ref)` sends SIGTERM, escalates to SIGKILL after timeout
- `health(ref)` checks subprocess liveness
- Test: spawn a subprocess (`echo hello`), assert it exits cleanly; spawn `sleep 30`, terminate, assert SIGTERM delivery; health check on a running subprocess returns healthy
  **Verify:** `npx vitest run src/octo/adapters/cli-exec.test.ts -t spawn`
  **Est:** 1.5h

## M2-06 — CliExecAdapter: structured output parsing

**Status:** done
**Depends on:** M2-05
**Context docs:** LLD.md §CliExecAdapter §stream(), wire/schema.ts CliExecRuntimeOptionsSchema.structuredOutputFormat
**Blast radius:** `src/octo/adapters/cli-exec.ts` (modify), `src/octo/adapters/cli-exec.test.ts` (modify)
**Acceptance:**

- `stream(ref)` reads subprocess stdout line-by-line, parses per `structuredOutputFormat` (`stream-json`, `json`, `ndjson`, `none`)
- Yields normalized `AdapterEvent` records via the EventNormalizer
- Extracts cost/token metadata when the tool provides it (e.g., Claude Code's `stream-json` includes cost fields)
- Test: mock subprocess emitting JSON lines, assert AdapterEvents produced in order with correct types
  **Verify:** `npx vitest run src/octo/adapters/cli-exec.test.ts -t stream`
  **Est:** 1.5h

## M2-07 — CliExecAdapter: send + checkpoint

**Status:** done
**Depends on:** M2-05
**Context docs:** LLD.md §CliExecAdapter §send(), §checkpoint()
**Blast radius:** `src/octo/adapters/cli-exec.ts` (modify), `src/octo/adapters/cli-exec.test.ts` (modify)
**Acceptance:**

- `send(ref, message)` writes to subprocess stdin when `stdinMode: "open"`. Returns structured error when stdin is not available
- `checkpoint(ref)` snapshots subprocess pid, elapsed time, stdout byte count, tool-reported progress markers
- Test: subprocess with open stdin receives sent messages; checkpoint captures expected metadata
  **Verify:** `npx vitest run src/octo/adapters/cli-exec.test.ts -t "send|checkpoint"`
  **Est:** 1h

## M2-08 — OCTO-DEC-038 resolution: initial_input duplication

**Status:** done
**Depends on:** M2-05
**Context docs:** DECISIONS.md OCTO-DEC-038, wire/schema.ts TODO comment on CliExecRuntimeOptionsSchema
**Blast radius:** `src/octo/wire/schema.ts` (possibly modify), `docs/octopus-orchestrator/DECISIONS.md` (modify)
**Acceptance:**

- The ambiguity between `ArmSpec.initial_input` and `CliExecRuntimeOptions.stdinInput` is resolved with a clear precedence rule
- The TODO comment in wire/schema.ts is removed or replaced with the resolution
- DECISIONS.md OCTO-DEC-038 status updated from deferred to resolved
- If schema changes are needed, existing tests updated to match
  **Verify:** `npx vitest run src/octo/wire/schema.test.ts`
  **Est:** 30min

## M2-09 — PtyTmuxAdapter: full implementation

**Status:** done
**Depends on:** M2-01, M2-02, M1-10
**Context docs:** LLD.md §PtyTmuxAdapter (line 420)
**Blast radius:** `src/octo/adapters/pty-tmux.ts`, `src/octo/adapters/pty-tmux.test.ts`
**Acceptance:**

- Full `Adapter` interface implementation replacing M1's direct TmuxManager calls
- `stream(ref)` captures pane output via `tmux capture-pane -p` on polling interval, normalizes to AdapterEvent chunks
- `send(ref, message)` via `tmux send-keys`
- `checkpoint(ref)` includes cwd, pane byte offset, session name, process liveness
- `attach(ref)` returns the `tmux attach -t <name>` command string
- Test: spawn a session, capture output, send input, verify round-trip; checkpoint contains expected metadata
  **Verify:** `npx vitest run src/octo/adapters/pty-tmux.test.ts`
  **Est:** 2h

## M2-10 — SubagentAdapter: bridge implementation

**Status:** done
**Depends on:** M2-01, M2-02, M2-04
**Context docs:** LLD.md §SubagentAdapter (around line 375), INTEGRATION.md §Upstream Dependency Classification (sessions_spawn row)
**Blast radius:** `src/octo/adapters/subagent.ts`, `src/octo/adapters/openclaw/sessions-spawn.ts` (fill bridge), `src/octo/adapters/subagent.test.ts`
**Acceptance:**

- `sessions-spawn.ts` bridge exports a typed interface `SessionsSpawnBridge` + a real implementation (dynamic import) + a mock factory for tests
- `SubagentAdapter` implements `Adapter` interface, delegates to the bridge
- Maps subagent output stream to normalized AdapterEvents
- `task_ref` populated on the ArmRecord pointing at the task ledger entry
- Test (uses mock bridge): spawn a subagent arm, stream events, verify normalized output; terminate cleans up
  **Verify:** `npx vitest run src/octo/adapters/subagent.test.ts`
  **Est:** 2h

## M2-11 — AcpAdapter: bridge implementation

**Status:** done
**Depends on:** M2-01, M2-02, M2-04
**Context docs:** LLD.md §AcpAdapter (line 442), DECISIONS.md OCTO-DEC-036 (opt-in only)
**Blast radius:** `src/octo/adapters/acp.ts`, `src/octo/adapters/openclaw/acpx-bridge.ts` (fill bridge), `src/octo/adapters/acp.test.ts`
**Acceptance:**

- `acpx-bridge.ts` bridge exports a typed interface `AcpxBridge` + a real implementation (dynamic import) + a mock factory for tests
- `AcpAdapter` implements `Adapter` interface, delegates to the bridge
- **Explicit opt-in enforcement per OCTO-DEC-036:** the adapter's `spawn` logs a warning if selected automatically (should only be reached via explicit `adapter_type: "structured_acp"` in the ArmSpec)
- Test (uses mock bridge): spawn an ACP arm, stream events, verify normalized output
  **Verify:** `npx vitest run src/octo/adapters/acp.test.ts`
  **Est:** 1.5h

## M2-12 — Task ledger bridge

**Status:** done
**Depends on:** M2-10
**Context docs:** INTEGRATION.md §Upstream Dependency Classification (task ledger row), DECISIONS.md OCTO-DEC-030 (Task Flow mirrored mode)
**Blast radius:** `src/octo/adapters/openclaw/task-ledger.ts` (fill bridge), `src/octo/adapters/openclaw/task-ledger.test.ts`
**Acceptance:**

- Bridge exports `TaskLedgerBridge` interface with `createTaskRef(armRecord)`, `syncStatus(armRecord)`, `resolveTaskRef(task_ref)`
- For subagent and ACP arms: `task_ref` on ArmRecord points at the corresponding task ledger entry
- Ensures `openclaw tasks list` and `openclaw octo arm list` never disagree on status (M2 exit criterion #3)
- Test (uses mock bridge): create a ref, sync status, verify the bridge was called correctly
  **Verify:** `npx vitest run src/octo/adapters/openclaw/task-ledger.test.ts`
  **Est:** 1h

## M2-13 — octo.arm.send handler (route through adapter)

**Status:** done
**Depends on:** M2-04, M2-05
**Context docs:** LLD.md §Head ↔ Node Agent Wire Contract (arm.send row)
**Blast radius:** `src/octo/wire/gateway-handlers.ts` (modify), `src/octo/wire/gateway-handlers.test.ts` (modify)
**Acceptance:**

- `armSend(request)` looks up the arm, gets the adapter via factory, calls `adapter.send(ref, message)`
- For CliExecAdapter: writes to stdin when stdinMode is open; returns structured error when not
- For PtyTmuxAdapter: sends keystrokes via `tmux send-keys`
- For adapters that don't support send: returns structured AdapterError("not_supported")
- Test: spawn a cli_exec arm with open stdin, send a message, verify it arrived; spawn a pty_tmux arm, send keys, verify; attempt send on an adapter that doesn't support it, verify structured error
  **Verify:** `npx vitest run src/octo/wire/gateway-handlers.test.ts -t send`
  **Est:** 1h

## M2-14 — octo.arm.attach + octo.arm.checkpoint handlers

**Status:** done
**Depends on:** M2-04, M2-09
**Context docs:** LLD.md §Head ↔ Node Agent Wire Contract (arm.attach, arm.checkpoint rows)
**Blast radius:** `src/octo/wire/gateway-handlers.ts` (modify), `src/octo/wire/gateway-handlers.test.ts` (modify)
**Acceptance:**

- `armAttach(request)` — for pty_tmux: returns the attach command; for cli_exec: returns "not_supported" (no interactive attach for subprocesses); for subagent/acp: returns the session key
- `armCheckpoint(request)` — routes through adapter.checkpoint, stores the checkpoint ref on the arm row, emits arm.checkpoint event
- Test: attach returns the right response shape per adapter type; checkpoint stores the ref
  **Verify:** `npx vitest run src/octo/wire/gateway-handlers.test.ts -t "attach|checkpoint"`
  **Est:** 1h

## M2-15 — Fill remaining OpenClaw bridges (features-advertiser, skills-loader, memory-bridge, presence-bridge, agent-config, taskflow-bridge, gateway-bridge)

**Status:** done
**Depends on:** M2-10
**Context docs:** INTEGRATION.md §Upstream Dependency Classification (all rows), DECISIONS.md OCTO-DEC-033
**Blast radius:** `src/octo/adapters/openclaw/{features-advertiser,skills-loader,memory-bridge,presence-bridge,agent-config,taskflow-bridge,gateway-bridge}.ts` (fill 7 bridges)
**Acceptance:**

- Each bridge exports: a typed interface, a real implementation (dynamic import with graceful degradation), a mock factory for tests
- `features-advertiser.ts` wires `buildFeaturesOcto` into the hello-ok handshake path
- `taskflow-bridge.ts` implements mirrored-mode Task Flow record creation per OCTO-DEC-030
- `presence-bridge.ts` emits presence updates for active arms
- `skills-loader.ts`, `memory-bridge.ts`, `agent-config.ts` pass through existing OpenClaw facilities to arm contexts
- `gateway-bridge.ts` routes Octopus logs through OpenClaw's logging framework
- Test: each bridge's mock factory produces a usable mock; interface methods have correct signatures
  **Verify:** `for f in src/octo/adapters/openclaw/*.ts; do grep -q 'interface\|export' "$f" || exit 1; done && echo OK`
  **Est:** 3h

## M2-16 — Logging integration: route octo logs through OpenClaw logging

**Status:** done
**Depends on:** M2-15
**Context docs:** INTEGRATION.md §First-Class Citizenship Checklist (logs item)
**Blast radius:** `src/octo/head/logging.ts`, `src/octo/head/logging.test.ts`
**Acceptance:**

- `OctoLogger` class that delegates to the gateway-bridge logging interface
- All Octopus modules that currently use `console.info` / `console.error` switched to OctoLogger (or accept a logger parameter)
- Test: log messages flow through the mock gateway-bridge logger
  **Verify:** `npx vitest run src/octo/head/logging.test.ts`
  **Est:** 1h

## M2-17 — openclaw octo init setup wizard

**Status:** done
**Depends on:** M1-29, M2-15
**Context docs:** INTEGRATION.md §First-run and doctor (init section)
**Blast radius:** `src/octo/cli/init.ts`, `src/octo/cli/init.test.ts`
**Acceptance:**

- Interactive setup: creates `~/.openclaw/octo/` state dir, writes a default `octo:` config block if absent, runs doctor checks, reports readiness
- Non-interactive mode (`--yes`) applies defaults without prompting
- Test: init in a temp dir creates the expected structure; --yes mode works without stdin
  **Verify:** `npx vitest run src/octo/cli/init.test.ts`
  **Est:** 1.5h

## M2-18 — octo.enabled default flip to true

**Status:** done
**Depends on:** M2-15, M2-17
**Context docs:** CONFIG.md §Feature flag, DECISIONS.md OCTO-DEC-027
**Blast radius:** `src/octo/config/schema.ts` (modify DEFAULT_OCTO_CONFIG.enabled), `src/octo/config/schema.test.ts` (modify), `src/octo/config/loader.test.ts` (modify)
**Acceptance:**

- `DEFAULT_OCTO_CONFIG.enabled` changed from `false` to `true`
- All tests updated to reflect the new default (tests that asserted `enabled: false` by default now assert `enabled: true`)
- CONFIG.md header updated to note "default true after M2 exit"
  **Verify:** `npx vitest run src/octo/config/schema.test.ts && npx vitest run src/octo/config/loader.test.ts`
  **Est:** 30min

## M2-19 — Chaos test: adapter emits malformed events

**Status:** done
**Depends on:** M2-02, M2-03, M2-05
**Context docs:** TEST-STRATEGY.md M2 row 1
**Blast radius:** `src/octo/test/chaos/malformed-adapter-events.test.ts`
**Acceptance:**

- Inject malformed events through the EventNormalizer, assert: events rejected, arm continues running, anomaly event recorded
- Test includes: missing required fields, wrong types, corrupt JSON, oversized payloads
  **Verify:** `npx vitest run src/octo/test/chaos/malformed-adapter-events.test.ts`
  **Est:** 1h

## M2-20 — Chaos test: subagent session expires mid-grip

**Status:** done
**Depends on:** M2-10, M2-03
**Context docs:** TEST-STRATEGY.md M2 row 2
**Blast radius:** `src/octo/test/chaos/subagent-session-expiry.test.ts`
**Acceptance:**

- Mock subagent bridge simulates session expiry mid-grip
- Adapter surfaces the expiry as an AdapterEvent error
- Node Agent (or test harness) retries the grip per retry policy
- Test asserts: expiry detected, grip status transitions correctly, retry attempted
  **Verify:** `npx vitest run src/octo/test/chaos/subagent-session-expiry.test.ts`
  **Est:** 1.5h

## M2-21 — Integration test: all 4 adapter types spawn + list + terminate

**Status:** done
**Depends on:** M2-05, M2-09, M2-10, M2-11
**Context docs:** implementation-plan.md §Milestone 2 exit criteria (criterion #1)
**Blast radius:** `src/octo/test/integration/adapter-coverage.test.ts`
**Acceptance:**

- Spawn an arm via each of the 4 adapter types (cli_exec and pty_tmux use real processes; subagent and acp use mock bridges)
- Each arm appears in `listArms()` with the correct adapter_type
- Each arm can be terminated cleanly
- Test asserts all 4 types are first-class — none is rejected or treated as second-class
  **Verify:** `npx vitest run src/octo/test/integration/adapter-coverage.test.ts`
  **Est:** 1.5h

## M2-22 — Integration test: First-Class Citizenship Checklist

**Status:** done
**Depends on:** M2-15, M2-17, M2-18
**Context docs:** INTEGRATION.md §First-Class Citizenship Checklist (line 713)
**Blast radius:** `src/octo/test/integration/first-class-checklist.test.ts`
**Acceptance:**

- One test per checklist item (17 items from INTEGRATION.md §First-Class Citizenship Checklist)
- Each test verifies the condition is met programmatically or via structured assertion
- Items that require a running OpenClaw Gateway are tested via mock bridge interfaces; items that are pure code checks (e.g., "docs present at expected paths") are tested directly
- All 17 tests pass
  **Verify:** `npx vitest run src/octo/test/integration/first-class-checklist.test.ts`
  **Est:** 2h

## M2-23 — Upstream PR compatibility verification

**Status:** done
**Depends on:** M2-15
**Context docs:** INTEGRATION.md §Required Upstream Changes, COMPATIBILITY.md
**Blast radius:** `docs/octopus-orchestrator/COMPATIBILITY.md` (update), `src/octo/upstream-prs/*.md` (possibly update)
**Acceptance:**

- Each of the 11 PR drafts (PR-01..PR-11) verified against the CURRENT state of the target files (may have drifted since the `9ece252` pin)
- COMPATIBILITY.md updated with the current OpenClaw version tested against and any drift notes
- Any PR drafts that need adjustment are updated in-place
  **Verify:** `test -f docs/octopus-orchestrator/COMPATIBILITY.md && grep -q 'Last test run' docs/octopus-orchestrator/COMPATIBILITY.md`
  **Est:** 1h

## M2-24 — Milestone 2 exit review

**Status:** done
**Depends on:** M2-01 through M2-23
**Context docs:** implementation-plan.md §Milestone 2
**Blast radius:** `docs/octopus-orchestrator/STATE.md`, `docs/octopus-orchestrator/SESSION-LOG.md`
**Acceptance:**

- Every M2 task `status: done`
- All M2 exit criteria from implementation-plan.md verified:
  - Subagent, ACP, and PTY/tmux sessions appear as arms under `openclaw octo arm list`
  - Operator can inspect, attach, and resume through the same model
  - `openclaw tasks list` and `openclaw octo arm list` never disagree
  - M2 chaos tests pass
  - First-Class Citizenship Checklist all items checked
  - `octo.enabled` defaults to `true`
  - Upstream PR compatibility verified
- `STATE.md` updated with `MILESTONE_2_COMPLETE` marker
  **Verify:** `grep -q 'MILESTONE_2_COMPLETE' docs/octopus-orchestrator/STATE.md`
  **Est:** 30min

---

---

# Milestone 3 — Shared State, Claims, and Mission Coordination

Goal: introduce explicit coordination primitives so concurrent arms don't trample each other. Land mission creation, grip assignment, claim enforcement, artifact indexing, and the ambiguous-duplicate-execution resolution flow. After M3, operators can say "refactor these 4 services" and Octopus decomposes, coordinates, and prevents conflicts.

## Top-of-M3 conventions

All M0/M1/M2 conventions carry forward plus:

- **Mission graph execution:** the Head evaluates the mission DAG on every grip completion/failure event. Grips with unresolved dependencies stay queued; `grip.completed` triggers re-evaluation of dependents; `blocks_mission_on_failure: true` + grip failure → mission aborted.
- **Claim atomicity:** claim acquisition is atomic via SQLite transactions. Exactly one arm wins an exclusive claim; losers get a structured `ClaimDeniedError` and retry per grip retry policy.
- **Grip assignment is through the scheduler.** No direct arm-to-grip binding — the scheduler picks the best arm for each eligible grip based on capabilities, stickiness, locality, and fairness.
- **Ambiguous resolution is a design-then-implement flow.** M3-11 finalizes the design (seed in LLD §Recovery Flows §5); M3-12 implements it. The design task produces a DECISIONS entry; the implementation task follows it.

## M3-01 — Mission creation handler (octo.mission.create)

**Status:** done
**Depends on:** M2-04, M1-09
**Context docs:** LLD.md §Mission Graph Schema, LLD.md §Head ↔ Node Agent Wire Contract (mission.create row), wire/methods.ts OctoMissionCreateRequestSchema (from M0-04), wire/schema.ts MissionSpecSchema + validateMissionSpec
**Blast radius:** `src/octo/wire/gateway-handlers.ts` (modify), `src/octo/wire/gateway-handlers.test.ts` (modify)
**Acceptance:**

- `missionCreate(request)` handler validates MissionSpec (including graph cycle/duplicate/unknown-dep checks via validateMissionSpec), inserts MissionRecord via RegistryService, inserts all GripRecords from the graph in `queued` state, emits `mission.created` event
- Supports both inline MissionSpec and template_id (template resolution is a stub for M3 — just passes through the inline spec; templates land in a later milestone)
- Idempotency via mission_id (or via idempotency_key on the request)
- Test: create a mission with 3 grips in a linear chain (A → B → C), verify mission row + 3 grip rows + event
  **Verify:** `npx vitest run src/octo/wire/gateway-handlers.test.ts -t "mission.*create"`
  **Est:** 2h

## M3-02 — Mission pause/resume/abort handlers

**Status:** done
**Depends on:** M3-01
**Context docs:** LLD.md §Head ↔ Node Agent Wire Contract, wire/methods.ts OctoMissionPause/Resume/Abort schemas
**Blast radius:** `src/octo/wire/gateway-handlers.ts` (modify), `src/octo/wire/gateway-handlers.test.ts` (modify)
**Acceptance:**

- `missionPause(request)` → applies MissionFSM active→paused, emits mission.paused
- `missionResume(request)` → applies paused→active, emits mission.resumed
- `missionAbort(request)` → applies active/paused→aborted, terminates all live arms, emits mission.aborted
- Abort cascades: terminates all `starting`/`active`/`idle`/`blocked` arms via armTerminate
- Test: create mission, pause, resume, abort with cascade verification
  **Verify:** `npx vitest run src/octo/wire/gateway-handlers.test.ts -t "mission.*(pause|resume|abort)"`
  **Est:** 1.5h

## M3-03 — Grip assignment scheduler (MVP)

**Status:** done
**Depends on:** M3-01, M1-08, M2-04
**Context docs:** LLD.md §Scheduler Algorithm, LLD.md §Fairness across missions, CONFIG.md scheduler.weights
**Blast radius:** `src/octo/head/scheduler.ts`, `src/octo/head/scheduler.test.ts`
**Acceptance:**

- `SchedulerService.assignNextGrip()` picks the highest-priority eligible grip (unresolved deps complete, not blocked by claim) from the mission with the lowest virtual time, scores candidate arms using the 6 weights from OctoConfigSchema.scheduler.weights, assigns the grip, emits grip.assigned event
- Grip eligibility: all depends_on grips are `completed` or `archived`
- Weighted scoring: stickiness (reuse warm arm) + locality (prefer same-node) + preferredMatch (capability alignment) + loadBalance (least-busy arm) + recentFailurePenalty + crossAgentIdPenalty
- Test: 2 missions with different priorities, verify fairness across 10 assignment rounds; grip with unsatisfied dep stays queued
  **Verify:** `npx vitest run src/octo/head/scheduler.test.ts`
  **Est:** 3h

## M3-04 — Grip lifecycle: assigned → running → completed/failed

**Status:** done
**Depends on:** M3-03, M1-08
**Context docs:** LLD.md §State Machines (Grip state machine), LLD.md §Graph rules
**Blast radius:** `src/octo/head/grip-lifecycle.ts`, `src/octo/head/grip-lifecycle.test.ts`
**Acceptance:**

- `GripLifecycleService.startGrip(gripId, armId)` → transitions grip assigned→running, spawns the arm (or binds to existing arm), emits grip.running
- `GripLifecycleService.completeGrip(gripId, result)` → transitions running→completed, stores result artifact ref, emits grip.completed, triggers mission graph re-evaluation (wake dependent grips)
- `GripLifecycleService.failGrip(gripId, reason)` → transitions running→failed, applies retry policy, either requeues (failed→queued) or abandons (failed→abandoned), checks blocks_mission_on_failure
- Test: linear chain A→B→C, complete A, verify B becomes eligible; fail A with blocks_mission_on_failure: true, verify mission aborts
  **Verify:** `npx vitest run src/octo/head/grip-lifecycle.test.ts`
  **Est:** 2h

## M3-05 — ClaimService: acquire/release/expire/conflict detection

**Status:** done
**Depends on:** M1-02
**Context docs:** LLD.md §ClaimRecord, LLD.md §ClaimService, wire/schema.ts ClaimRequestSchema
**Blast radius:** `src/octo/head/claims.ts`, `src/octo/head/claims.test.ts`
**Acceptance:**

- `ClaimService.acquire(armId, claims: ClaimRequest[])` → atomic acquisition via SQLite transaction. For each claim: if no existing claim on the resource, insert; if existing exclusive claim by another arm, throw `ClaimDeniedError`; if existing shared-read claim and requesting shared-read, allow (multiple readers); if existing shared-read and requesting exclusive, deny
- `ClaimService.release(armId, claimIds)` → marks claims as released, emits claim.released events
- `ClaimService.expireStale(now)` → expires claims whose lease_expiry_ts has passed, emits claim.expired events
- Conflict detection is eager (at acquire time, not lazy)
- Test: two arms claim the same file exclusively — exactly one wins, loser gets ClaimDeniedError; shared-read coexistence; expiry cleanup
  **Verify:** `npx vitest run src/octo/head/claims.test.ts`
  **Est:** 2h

## M3-06 — ArtifactService: persist/lookup/index

**Status:** done
**Depends on:** M1-02
**Context docs:** LLD.md §ArtifactRecord, LLD.md §ArtifactService
**Blast radius:** `src/octo/head/artifacts.ts`, `src/octo/head/artifacts.test.ts`
**Acceptance:**

- `ArtifactService.record(artifact)` → inserts ArtifactRecord (immutable — no version column per M1-01 schema design), emits artifact.recorded event
- `ArtifactService.get(artifactId)` → returns ArtifactRecord or null
- `ArtifactService.listByMission(missionId)` → returns all artifacts for a mission
- `ArtifactService.listByArm(armId)` → returns all artifacts for an arm
- `ArtifactService.listByGrip(gripId)` → returns all artifacts for a grip
- Test: record 5 artifacts across 2 missions, query by mission, query by arm, query by grip
  **Verify:** `npx vitest run src/octo/head/artifacts.test.ts`
  **Est:** 1h

## M3-07 — Grip retry with RetryPolicy

**Status:** done
**Depends on:** M3-04, M1-08
**Context docs:** LLD.md §Retry and Backoff, wire/schema.ts RetryPolicySchema, config/schema.ts retryPolicyDefault
**Blast radius:** `src/octo/head/retry.ts`, `src/octo/head/retry.test.ts`
**Acceptance:**

- `RetryService.shouldRetry(grip, failureClassification)` → consults the grip's RetryPolicy (or the config default), returns `{ retry: true, delay_ms }` or `{ retry: false, reason }`
- `RetryService.applyRetry(gripId)` → transitions grip failed→queued with incremented attempt count and computed backoff delay, emits retry event
- Backoff strategies: exponential (default), linear, fixed
- retry_on / abandon_on classification matching per RetryPolicySchema
- Test: 3 retries with exponential backoff, verify delays double; exceed max_attempts, verify grip abandoned; policy_denied failure immediately abandoned
  **Verify:** `npx vitest run src/octo/head/retry.test.ts`
  **Est:** 1.5h

## M3-08 — CLI: openclaw octo mission create/show/list/pause/resume/abort

**Status:** done
**Depends on:** M3-01, M3-02
**Context docs:** LLD.md §Operator Surfaces
**Blast radius:** `src/octo/cli/mission.ts`, `src/octo/cli/mission.test.ts`
**Acceptance:**

- `mission create --spec <json>` or `mission create --template <name>` → calls missionCreate handler
- `mission show <id>` → displays mission detail including grip graph and current state
- `mission list` → lists missions with status filter
- `mission pause/resume/abort <id>` → calls the corresponding handler
- `--json` mode for all
- Test: create a mission via CLI, show it, list it, pause, resume, abort
  **Verify:** `npx vitest run src/octo/cli/mission.test.ts`
  **Est:** 1.5h

## M3-09 — CLI: openclaw octo grip list/show/reassign + openclaw octo claims

**Status:** done
**Depends on:** M3-04, M3-05
**Context docs:** LLD.md §Operator Surfaces
**Blast radius:** `src/octo/cli/grip.ts`, `src/octo/cli/grip.test.ts`, `src/octo/cli/claims.ts`, `src/octo/cli/claims.test.ts`
**Acceptance:**

- `grip list [--mission <id>] [--status <status>]` → lists grips with filters
- `grip show <id>` → grip detail including dependencies, assigned arm, retry count
- `grip reassign <id> [--to <arm_id|node_id>]` → calls grip reassign handler
- `claims list [--resource-type <type>] [--owner <arm_id>]` → lists active claims
- `--json` mode for all
- Test: list grips after mission creation, show a grip, list claims after acquisition
  **Verify:** `npx vitest run src/octo/cli/grip.test.ts && npx vitest run src/octo/cli/claims.test.ts`
  **Est:** 1.5h

## M3-10 — Mission graph re-evaluation engine

**Status:** done
**Depends on:** M3-04, M3-01
**Context docs:** LLD.md §Mission Graph Schema §Graph rules
**Blast radius:** `src/octo/head/graph-evaluator.ts`, `src/octo/head/graph-evaluator.test.ts`
**Acceptance:**

- `GraphEvaluator.onGripCompleted(missionId, gripId)` → finds dependent grips whose ALL deps are now completed, transitions them from queued to eligible (makes them visible to the scheduler)
- `GraphEvaluator.onGripFailed(missionId, gripId)` → if the failed grip has `blocks_mission_on_failure: true`, abort the entire mission; otherwise mark dependents as blocked
- Supports linear chains, simple fan-out, simple fan-in (MVP graph shapes per LLD §Minimal MVP graph)
- Test: diamond dependency (A → [B, C] → D), complete A, verify B and C become eligible; complete B, D stays queued; complete C, D becomes eligible; fail B with blocks_mission: true, verify mission aborts
  **Verify:** `npx vitest run src/octo/head/graph-evaluator.test.ts`
  **Est:** 2h

## M3-11 — Ambiguous duplicate-execution resolution: design decision

**Status:** done
**Depends on:** M3-04, M3-05
**Context docs:** LLD.md §Recovery Flows §5 (seed design), DECISIONS.md
**Blast radius:** `docs/octopus-orchestrator/DECISIONS.md` (add OCTO-DEC-041)
**Acceptance:**

- New decision OCTO-DEC-041 finalizing the resolution policy for `grip.ambiguous` events, refining the seed in LLD §Recovery Flows §5
- The decision must address: read-only grips (automated selection), non-side-effecting grips (operator-reviewed), side-effecting grips (operator-only resolution)
- The decision must specify the data model: how are ambiguous results stored, how does the operator review them, what events are emitted on resolution
- Implementation follows in M3-12
  **Verify:** `grep -q 'OCTO-DEC-041' docs/octopus-orchestrator/DECISIONS.md`
  **Est:** 1h

## M3-12 — Ambiguous duplicate-execution resolution: implementation

**Status:** done
**Depends on:** M3-11, M3-06
**Context docs:** DECISIONS.md OCTO-DEC-041 (from M3-11)
**Blast radius:** `src/octo/head/ambiguous-resolver.ts`, `src/octo/head/ambiguous-resolver.test.ts`
**Acceptance:**

- `AmbiguousResolver.onGripAmbiguous(gripId, candidateArmIds)` → quarantines both results as artifacts, emits grip.ambiguous event, surfaces to operator via CLI
- For read-only grips: auto-resolves by lowest arm_id lexicographic order (per LLD seed)
- For non-side-effecting grips: surfaces both results in a diff view, awaits operator selection
- For side-effecting grips: alerts operator, no automated resolution
- `AmbiguousResolver.resolve(gripId, selectedArmId)` → selects one result, marks the other as discarded, emits resolution event
- Test: trigger ambiguous on a read-only grip, verify auto-resolution; trigger on a side-effecting grip, verify operator-required state
  **Verify:** `npx vitest run src/octo/head/ambiguous-resolver.test.ts`
  **Est:** 2h

## M3-13 — Worktree coordination for parallel coding arms

**Status:** done
**Depends on:** M3-05
**Context docs:** LLD.md §ClaimRecord (resource_type: "dir", "branch"), HLD.md §Worktree as a Coordination Primitive
**Blast radius:** `src/octo/head/worktree-coordinator.ts`, `src/octo/head/worktree-coordinator.test.ts`
**Acceptance:**

- `WorktreeCoordinator.acquireWorktree(armId, repoPath, branchName)` → creates a git worktree for the arm, acquires exclusive claims on the worktree dir + the branch name
- `WorktreeCoordinator.releaseWorktree(armId)` → removes the worktree, releases claims
- Two arms requesting overlapping worktrees: one wins, other gets ClaimDeniedError
- Test: 2 arms claim sibling worktrees on the same repo — both succeed (different branches); 2 arms claim the same branch — one wins
  **Verify:** `npx vitest run src/octo/head/worktree-coordinator.test.ts`
  **Est:** 1.5h

## M3-14 — Chaos test: two arms claim the same file concurrently

**Status:** done
**Depends on:** M3-05
**Context docs:** TEST-STRATEGY.md M3 row 1
**Blast radius:** `src/octo/test/chaos/concurrent-file-claim.test.ts`
**Acceptance:**

- Spawn 2 arms, both attempt to acquire an exclusive claim on the same file path concurrently
- Exactly one wins; the loser gets ClaimDeniedError
- Winner can release; after release, a new acquisition by the loser succeeds
  **Verify:** `npx vitest run src/octo/test/chaos/concurrent-file-claim.test.ts`
  **Est:** 1h

## M3-15 — Chaos test: ambiguous duplicate grip completion

**Status:** done
**Depends on:** M3-12
**Context docs:** TEST-STRATEGY.md M3 row 2
**Blast radius:** `src/octo/test/chaos/ambiguous-grip-completion.test.ts`
**Acceptance:**

- Two arms complete the same grip (simulated by calling completeGrip from both)
- Both results quarantined, operator prompted, no auto-merge for side-effecting grips
- For read-only grips: auto-resolved by lowest arm_id
  **Verify:** `npx vitest run src/octo/test/chaos/ambiguous-grip-completion.test.ts`
  **Est:** 1.5h

## M3-16 — Integration test: worktree coordination (parallel arms on sibling worktrees)

**Status:** done
**Depends on:** M3-13
**Context docs:** implementation-plan.md §Milestone 3 exit criteria
**Blast radius:** `src/octo/test/integration/worktree-coordination.test.ts`
**Acceptance:**

- 2 arms on sibling git worktrees (different branches, same repo) complete work without collision
- Claims prevent overlapping branch names
  **Verify:** `npx vitest run src/octo/test/integration/worktree-coordination.test.ts`
  **Est:** 1.5h

## M3-17 — Integration test: full mission lifecycle (create → assign → run → complete)

**Status:** done
**Depends on:** M3-04, M3-10, M3-03
**Context docs:** implementation-plan.md §Milestone 3 exit criteria
**Blast radius:** `src/octo/test/integration/mission-lifecycle.test.ts`
**Acceptance:**

- Create a mission with 3 grips (A → B → C), scheduler assigns A to an arm, A completes, B becomes eligible, scheduler assigns B, B completes, C runs, mission completes
- Verify: mission state transitions (active → completed), all 3 grips completed, events emitted in order
  **Verify:** `npx vitest run src/octo/test/integration/mission-lifecycle.test.ts`
  **Est:** 2h

## M3-18 — Milestone 3 exit review

**Status:** done
**Depends on:** M3-01 through M3-17
**Context docs:** implementation-plan.md §Milestone 3
**Blast radius:** `docs/octopus-orchestrator/STATE.md`, `docs/octopus-orchestrator/SESSION-LOG.md`
**Acceptance:**

- Every M3 task `status: done`
- All M3 exit criteria from implementation-plan.md verified:
  - Concurrent arms coordinate safely without trampling each other
  - Duplicate-execution resolution flow documented, implemented, and tested
  - M3 chaos tests pass (concurrent file claim, ambiguous duplicate grip)
  - Worktree coordination validated
- `STATE.md` updated with `MILESTONE_3_COMPLETE` marker
  **Verify:** `grep -q 'MILESTONE_3_COMPLETE' docs/octopus-orchestrator/STATE.md`
  **Est:** 30min

---

---

# Milestone 4 — Distributed Habitats (13 tasks)

Goal: extend orchestration across multiple nodes via existing Gateway `role: node` wire.

## M4-01 — LeaseService: issue/renew/expire

**Status:** done
**Depends on:** M1-02
**Blast radius:** `src/octo/head/leases.ts`, `src/octo/head/leases.test.ts`
**Acceptance:** LeaseService with issue/renew/expireStale + grace window differentiation for side-effecting grips. Test: issue, renew extends, expire after TTL.
**Verify:** `npx vitest run src/octo/head/leases.test.ts`
**Est:** 1.5h

## M4-02 — Lease heartbeat handler (octo.lease.renew push)

**Status:** done
**Depends on:** M4-01
**Blast radius:** `src/octo/wire/gateway-handlers.ts` (modify), `src/octo/wire/gateway-handlers.test.ts` (modify)
**Acceptance:** Handler processes batched lease renewals from Node Agents. Test: send batch, verify leases extended.
**Verify:** `npx vitest run src/octo/wire/gateway-handlers.test.ts -t lease`
**Est:** 1h

## M4-03 — Capability-aware scheduler extension

**Status:** done
**Depends on:** M3-03, M4-01
**Blast radius:** `src/octo/head/scheduler.ts` (modify), `src/octo/head/scheduler.test.ts` (modify)
**Acceptance:** Scheduler filters arms by capability match against desired_capabilities[]. Test: grip requiring tool.git, 2 nodes, one without git → scheduler picks correct node.
**Verify:** `npx vitest run src/octo/head/scheduler.test.ts -t capability`
**Est:** 1.5h

## M4-04 — Node Agent Gateway client (role: node connect)

**Status:** done
**Depends on:** M2-03, M4-01
**Blast radius:** `src/octo/node-agent/gateway-client.ts`, `src/octo/node-agent/gateway-client.test.ts`
**Acceptance:** Connects as role:node with caps.octo, sends lease renewals, dispatches incoming commands. Test: mock WS server, client connects, sends caps.
**Verify:** `npx vitest run src/octo/node-agent/gateway-client.test.ts`
**Est:** 2h

## M4-05 — Per-node sidecar unacked-transition log

**Status:** done
**Depends on:** M2-03
**Blast radius:** `src/octo/node-agent/pending-log.ts`, `src/octo/node-agent/pending-log.test.ts`
**Acceptance:** PendingLog with append/replay/ack at pending.jsonl. Test: append 5, ack 3, replay returns 2.
**Verify:** `npx vitest run src/octo/node-agent/pending-log.test.ts`
**Est:** 1h

## M4-06 — Remote reconciliation flow

**Status:** done
**Depends on:** M4-04, M1-13, M4-05
**Blast radius:** `src/octo/node-agent/remote-reconciler.ts`, `src/octo/node-agent/remote-reconciler.test.ts`
**Acceptance:** On reconnect: replay pending log, run SessionReconciler, report discrepancies. Test: simulate disconnect + reconnect.
**Verify:** `npx vitest run src/octo/node-agent/remote-reconciler.test.ts`
**Est:** 2h

## M4-07 — Multi-node scheduling integration

**Status:** done
**Depends on:** M4-03, M4-04
**Blast radius:** `src/octo/head/multi-node-scheduler.ts`, `src/octo/head/multi-node-scheduler.test.ts`
**Acceptance:** Scheduler considers arms across connected nodes. Node capacity tracked from telemetry. Test: 2 mock nodes, grips routed correctly.
**Verify:** `npx vitest run src/octo/head/multi-node-scheduler.test.ts`
**Est:** 2h

## M4-08 — CLI: openclaw octo node list/show

**Status:** done
**Depends on:** M4-04
**Blast radius:** `src/octo/cli/node.ts`, `src/octo/cli/node.test.ts`
**Acceptance:** node list/show with capabilities, active arms, health. --json mode. Test: list nodes, show detail.
**Verify:** `npx vitest run src/octo/cli/node.test.ts`
**Est:** 1h

## M4-09 — Postgres migration evaluation gate

**Status:** done
**Depends on:** M4-07
**Blast radius:** `docs/octopus-orchestrator/DECISIONS.md`
**Acceptance:** OCTO-DEC-042 evaluating the 3 named migration triggers. Decision: migrate or defer.
**Verify:** `grep -q 'OCTO-DEC-042' docs/octopus-orchestrator/DECISIONS.md`
**Est:** 30min

## M4-10 — Chaos test: kill Node Agent mid-arm

**Status:** done
**Depends on:** M4-04, M4-01, M4-06
**Blast radius:** `src/octo/test/chaos/kill-node-agent.test.ts`
**Acceptance:** Lease expires, arm recovered/reassigned, duplicate-execution <5%.
**Verify:** `npx vitest run src/octo/test/chaos/kill-node-agent.test.ts`
**Est:** 2h

## M4-11 — Chaos test: wrong idempotency key

**Status:** done
**Depends on:** M4-04
**Blast radius:** `src/octo/test/chaos/wrong-idempotency-key.test.ts`
**Acceptance:** Tampered key rejected, no state change.
**Verify:** `npx vitest run src/octo/test/chaos/wrong-idempotency-key.test.ts`
**Est:** 1h

## M4-12 — Chaos test: clock skew ±30s

**Status:** done
**Depends on:** M4-01, M4-04
**Blast radius:** `src/octo/test/chaos/clock-skew.test.ts`
**Acceptance:** ±30s skew, leases honored, no premature reassignment.
**Verify:** `npx vitest run src/octo/test/chaos/clock-skew.test.ts`
**Est:** 1.5h

## M4-13 — Milestone 4 exit review

**Status:** done
**Depends on:** M4-01 through M4-12
**Blast radius:** `docs/octopus-orchestrator/STATE.md`, `docs/octopus-orchestrator/SESSION-LOG.md`
**Acceptance:** All done, exit criteria met, `MILESTONE_4_COMPLETE` marker.
**Verify:** `grep -q 'MILESTONE_4_COMPLETE' docs/octopus-orchestrator/STATE.md`
**Est:** 30min

---

# Milestone 5 — Safety and Advanced Supervision (9 tasks)

Goal: make the system operationally trustworthy at scale. Activate policy enforcement.

## M5-01 — PolicyService: resolve/allow/deny/escalate

**Status:** done
**Depends on:** M4-13
**Blast radius:** `src/octo/head/policy.ts`, `src/octo/head/policy.test.ts`
**Acceptance:** PolicyService resolves profiles, checks allow/deny/escalate, layers over existing OpenClaw per-agent tools.allow/deny. enforcementActive flag gates blocking vs logging.
**Verify:** `npx vitest run src/octo/head/policy.test.ts`
**Est:** 2h

## M5-02 — Policy enforcement in arm.spawn + grip lifecycle

**Status:** done
**Depends on:** M5-01
**Blast radius:** `src/octo/wire/gateway-handlers.ts` (modify), `src/octo/wire/gateway-handlers.test.ts` (modify)
**Acceptance:** arm.spawn checks PolicyService; on deny → HandlerError("policy_denied"). All decisions logged. Test: spawn denied/allowed.
**Verify:** `npx vitest run src/octo/wire/gateway-handlers.test.ts -t policy`
**Est:** 1.5h

## M5-03 — Approval routing (octo.approval.\* flow)

**Status:** done
**Depends on:** M5-01
**Blast radius:** `src/octo/head/approvals.ts`, `src/octo/head/approvals.test.ts`
**Acceptance:** ApprovalService with request/approve/reject. Multi-operator for shared missions. Uses octo.writer (OCTO-DEC-029), NOT tools.elevated.
**Verify:** `npx vitest run src/octo/head/approvals.test.ts`
**Est:** 2h

## M5-04 — Quarantine flows

**Status:** done
**Depends on:** M5-01, M1-07
**Blast radius:** `src/octo/head/quarantine.ts`, `src/octo/head/quarantine.test.ts`
**Acceptance:** QuarantineService with quarantine/release. Auto-quarantine on maxRestarts exceeded. Operator release via quarantined→starting.
**Verify:** `npx vitest run src/octo/head/quarantine.test.ts`
**Est:** 1.5h

## M5-05 — Historical replay compliance report

**Status:** done
**Depends on:** M5-01, M1-04
**Blast radius:** `src/octo/head/compliance-report.ts`, `src/octo/head/compliance-report.test.ts`
**Acceptance:** ComplianceReporter replays event log, evaluates arms against a policy profile, produces violation report.
**Verify:** `npx vitest run src/octo/head/compliance-report.test.ts`
**Est:** 1.5h

## M5-06 — Config: flip policy.enforcementActive to true

**Status:** done
**Depends on:** M5-02
**Blast radius:** `src/octo/config/schema.ts` (modify), `src/octo/config/schema.test.ts` (modify)
**Acceptance:** DEFAULT_OCTO_CONFIG.policy.enforcementActive = true. Tests updated.
**Verify:** `npx vitest run src/octo/config/schema.test.ts`
**Est:** 15min

## M5-07 — Chaos test: policy denies a spawn

**Status:** done
**Depends on:** M5-02
**Blast radius:** `src/octo/test/chaos/policy-denied-spawn.test.ts`
**Acceptance:** Policy denies spawn, no arm created, denial recorded with actor + rule.
**Verify:** `npx vitest run src/octo/test/chaos/policy-denied-spawn.test.ts`
**Est:** 1h

## M5-08 — Chaos test: operator without octo.writer rejected

**Status:** done
**Depends on:** M5-03
**Blast radius:** `src/octo/test/chaos/missing-writer-capability.test.ts`
**Acceptance:** Non-writer operator rejected, audit event written.
**Verify:** `npx vitest run src/octo/test/chaos/missing-writer-capability.test.ts`
**Est:** 1h

## M5-09 — Milestone 5 exit review

**Status:** done
**Depends on:** M5-01 through M5-08
**Blast radius:** `docs/octopus-orchestrator/STATE.md`, `docs/octopus-orchestrator/SESSION-LOG.md`
**Acceptance:** All done, exit criteria met, `MILESTONE_5_COMPLETE` marker. Aggregate: 95% arm failures recoverable across M1-M4 chaos tests.
**Verify:** `grep -q 'MILESTONE_5_COMPLETE' docs/octopus-orchestrator/STATE.md`
**Est:** 30min

---

## Final milestone boundary

All 5 milestones spec'd (M0: 26, M1: 30, M2: 24, M3: 18, M4: 13, M5: 9 = 120 total tasks). Phase 6 (preemption, diamond dependencies, warm arm pools, multi-head HA) is research-stage.
