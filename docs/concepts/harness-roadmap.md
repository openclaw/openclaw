---
summary: "Living checklist and roadmap for turning OpenClaw into a thinner, more controllable harness"
read_when:
  - You are planning or reviewing harness-related work in OpenClaw
  - You want a single status board for bootstrap, context, verify, and policy work
  - You want a repeatable way to update roadmap status after each improvement
owner: "OpenClaw harness"
freshness: "weekly"
last_reviewed: "2026-03-25"
title: "Harness Roadmap"
---

# Harness roadmap

This page is the living checklist and rollout plan for harness work in OpenClaw.

## Goal

Turn OpenClaw into a thinner, more controllable harness by improving:

- bootstrap clarity
- context observability
- tool and skill exposure control
- workspace policy handling
- verification and retry behavior

## Status legend

- `todo` = not started
- `doing` = actively in progress
- `done` = implemented and verified
- `deferred` = intentionally postponed

## Current snapshot

- Last updated: `2026-03-25`
- Current phase: `Post-roadmap P5 Phase 1`
- Current focus: `role presets, build-run artifacts, and role-aware spawn defaults are in place; next up is verify-pack contracts`
- Latest completed milestone: `P5 Phase 1 issue 3 landed: role-aware spawn defaults now apply bounded tool surfaces, builder prompt mode, and build-run artifact references to spawned runs`
- Next recommended milestone: `P5 Phase 1 issue 4: verify-pack schema with exec / logs / report checks`

## Success metrics

- Reduce injected bootstrap volume for common coding runs by `30% to 50%`
- Keep default tool exposure narrower and easier to explain
- Make verification status more trustworthy than model self-report
- Keep retry behavior bounded and observable
- Make workspace policy sources explicit and inspectable

## Master checklist

### Phase 1 - Foundation

| Status | Item                                   | Notes                                                                                                                                                                        |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done` | Native `OPENCLAW.md` bootstrap support | Implemented in workspace loading, subagent filtering, sandbox seeding, docs, build, and live workspace smoke test                                                            |
| `done` | Prompt budget breakdown                | Added `promptBudget` to `systemPromptReport`, surfaced it in `/context`, covered it with tests, and verified it in a live local-agent smoke test                             |
| `done` | Task profile schema                    | Added first-class `coding`, `research`, `ops`, `assistant` task profiles to `systemPromptReport` and `/context`, with source/signal reporting and live smoke-test validation |
| `done` | Workspace policy discovery             | Discover and normalize repo-level policy files beyond fixed bootstrap names, report them in `systemPromptReport`, and surface them in `/context`                             |
| `done` | Policy slicing                         | Slice policy content before injection, report skipped chars/files, and validate the reduction in real runs                                                                   |

### Phase 2 - Control loops

| Status | Item                       | Notes                                                                                                                           |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `done` | Verify runner core         | Command-tool verification is now based on real `exec`/`bash` outcomes, persisted in session metadata, and visible in `/context` |
| `done` | Structured failure reasons | Failure categories like `verification`, `tool`, `context`, and `timeout` are now persisted and visible in `/context`            |
| `done` | Retry budget               | Bound retry count, track retry cause, persist retry state, and surface it in `/context`                                         |
| `done` | Prompt/context report UX   | `/context` now surfaces the largest prompt cost, largest injected workspace file, attention state, and next-action hint         |

### Phase 3 - Exposure control

| Status | Item                  | Notes                                                                                                                                                     |
| ------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done` | Profile-to-tool pack  | Prompt-aware default tool packs now narrow tools for coding, research, ops, and assistant runs unless an explicit allowlist/profile already exists        |
| `done` | Profile-to-skill pack | Prompt-aware default skill filtering now narrows injected skill prompts by task profile while preserving explicit skill filters and `always` skills       |
| `done` | Dynamic tool pruning  | Prompt-aware pruning now removes obviously irrelevant web, messaging, ops, and read-only mutation tools and reports the removed schema cost in `/context` |
| `done` | Dynamic skill pruning | Prompt-aware pruning now removes obviously irrelevant weather, ops, and skill-authoring skills and reports the removed skill-block cost in `/context`     |

### Phase 4 - Delegation and automation

| Status     | Item                             | Notes                                                                                                                                                               |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done`     | Delegation profile               | Runtime reporting now makes session role, control scope, inherited workspace, spawn requester/task context, and delegation-tool availability explicit in `/context` |
| `done`     | Failure-to-rule suggestions      | `/context` now turns structured verification, retry, tool, context, and prompt-budget signals into candidate policy rules with evidence                             |
| `done`     | Cron health checks               | `/context` now generates a schedulable isolated cron health-check plan with cadence, focus areas, rationale, and a ready-to-use prompt                              |
| `deferred` | Heavy DSL or orchestration layer | Do not build unless there is a clear need that simpler policy cannot handle                                                                                         |

### Post-roadmap backlog

| Status  | Item                                                           | Notes                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `done`  | Manual policy write-back flow                                  | `/context rule apply <key                                                                                                                                                                 | top> [OPENCLAW.md\|AGENTS.md\|CLAUDE.md]` now turns failure-rule suggestions into explicit policy patches with dedupe markers |
| `done`  | Cron health-check install flow                                 | `/context cron install` now creates or updates an isolated managed cron job from the current health-check suggestion                                                                      |
| `done`  | Workspace policy merge/source/conflict reporting               | `workspacePolicyDiscovery` now reports merge order, conflict count, source, tier, and priority for `AGENTS.md`, `OPENCLAW.md`, and `CLAUDE.md`                                            |
| `done`  | Repo knowledge index / plans / debt structure                  | Added docs index, `exec-plans/`, `tech-debt/`, and key-doc ownership/freshness metadata                                                                                                   |
| `done`  | Mechanical repo enforcement (P2 first pass)                    | Added harness-core boundary lint, repo-knowledge guard, security-audit remediation coverage, and tests; wired them into `pnpm check`                                                      |
| `done`  | Workspace health dashboard and trend reporting (P3 first pass) | `/context health` now aggregates workspace sessions into profile-level verify/cost/runtime/retry summaries plus current-vs-previous 7-day prompt/failure/retry trends                     |
| `done`  | Doc gardening / cleanup automation (P3 completion)             | `/context docs install` now creates or updates an isolated managed cron job that reviews stale repo-knowledge docs, missing knowledge stubs, and metadata drift                           |
| `doing` | Role-scoped build loop (P5 Phase 1)                            | Role presets and build-run artifacts are now first-class runtime/session concepts; next land role-aware spawn defaults, verify-pack contracts, and a first browser-backed evaluator slice |

## Why each item matters

### Phase 1 - Foundation

| Item                       | Why do this                                              | Value and benefit                                                                               | Simplest way to see value                                                                   |
| -------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Prompt budget breakdown    | We still do not know where prompt budget is being spent. | Makes waste visible so later pruning work has a real target.                                    | Run one task and see exact size breakdown for workspace, tools, skills, and system prompt.  |
| Task profile schema        | Different tasks still use one default setup.             | Lets coding, research, ops, and assistant runs behave differently instead of one-size-fits-all. | Compare a `coding` run and a `research` run and see different tool and skill surfaces.      |
| Workspace policy discovery | Policy files are still mostly found by human habit.      | Turns repo rules into a real runtime capability instead of oral tradition.                      | Open a different repo and see OpenClaw list which policy files it discovered automatically. |
| Policy slicing             | Whole policy files are heavier than most runs need.      | Shrinks context and keeps the model focused on only the relevant rules.                         | Injected policy chars go down while the answer becomes more on-topic.                       |

### Phase 2 - Control loops

| Item                       | Why do this                                                 | Value and benefit                                                   | Simplest way to see value                                                                                      |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Verify runner core         | "Model says it succeeded" is not a reliable success signal. | Separates action from verification and raises real success quality. | A task ends with an explicit verify step and clear verify result.                                              |
| Structured failure reasons | Failures are still too vague.                               | Makes failures diagnosable and easier to improve systematically.    | A failed run reports a reason like `verification`, `tool choice`, or `environment` instead of just noisy logs. |
| Retry budget               | Agents can waste time retrying without learning.            | Prevents loops, saves tokens, and makes retry behavior predictable. | A bad run stops after a fixed retry budget and shows why each retry happened.                                  |
| Prompt/context report UX   | Harness state is still harder to inspect than it should be. | Makes debugging context and prompt weight much faster.              | One glance shows why a run was heavy or confusing.                                                             |

### Phase 3 - Exposure control

| Item                  | Why do this                                                                      | Value and benefit                                        | Simplest way to see value                                                         |
| --------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Profile-to-tool pack  | Default tool exposure is still broader than many runs need.                      | Reduces tool confusion and unnecessary schema cost.      | A normal coding task exposes only a small, relevant set of tools.                 |
| Profile-to-skill pack | Default skill exposure is also broader than needed.                              | Reduces prompt noise and keeps the model more focused.   | Different profiles visibly load different skill sets.                             |
| Dynamic tool pruning  | Static tool packs still leave irrelevant tools in many runs.                     | Makes each run thinner than profile-level pruning alone. | A read-only task no longer exposes browser, message, or unrelated mutation tools. |
| Dynamic skill pruning | Static skill packs still include skills that do not matter for the current task. | Further reduces distraction and prompt overhead.         | Simple tasks show a much shorter skill list than before.                          |

### Phase 4 - Delegation and automation

| Item                             | Why do this                                                    | Value and benefit                                                            | Simplest way to see value                                                                          |
| -------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Delegation profile               | Subagent inheritance is still too implicit.                    | Makes multi-agent work more stable and easier to reason about.               | Each spawn can explain why it was created, what context it got, and what tools it can use.         |
| Failure-to-rule suggestions      | Repeated failures are currently wasted learning opportunities. | Turns recurring mistakes into candidate policy improvements.                 | After several runs, OpenClaw starts suggesting concrete rules worth adding.                        |
| Cron health checks               | Harness drift is slow and easy to miss manually.               | Finds stale rules, oversized context, and broken automation earlier.         | A periodic summary starts surfacing drift before it becomes a visible problem.                     |
| Heavy DSL or orchestration layer | It is easy to overbuild this too early.                        | Avoids spending energy on a big framework before smaller wins are exhausted. | We keep getting visible harness improvements without introducing a large new orchestration system. |

## Rollout roadmap

### Phase 1 - Foundation

**Outcome**

OpenClaw can explain what workspace policy it loaded, why it loaded it, and how much prompt budget it spent.

**Target deliverables**

- Native repo-level policy file support
- Prompt budget reporting
- Task profile schema
- Workspace policy discovery and slicing

**Exit criteria**

- A run can show its injected workspace files and prompt budget breakdown
- Repo-level policy surfaces are explicit and test-covered
- At least one profile-aware path exists for future tool and skill pruning

### Phase 2 - Control loops

**Outcome**

OpenClaw can verify results, report failure cause clearly, and avoid vague success states.

**Target deliverables**

- Verify runner
- Structured failure reason schema
- Retry budget and stop conditions

**Exit criteria**

- Verification is no longer only "model says it succeeded"
- Failed runs expose a useful reason category
- Retries are bounded and visible

### Phase 3 - Exposure control

**Outcome**

OpenClaw gives each run less irrelevant context and fewer irrelevant tools.

**Target deliverables**

- Profile-to-tool pack
- Profile-to-skill pack
- Dynamic pruning

**Exit criteria**

- Different task profiles show different tool and skill surfaces
- Prompt overhead from unused tools and skills is measurably lower

### Phase 4 - Delegation and automation

**Outcome**

OpenClaw can explain delegation decisions and use repeated failures to improve harness policy.

**Target deliverables**

- Delegation profile
- Failure-to-rule suggestions
- Cron-based health checks

**Exit criteria**

- Subagent context inheritance is explicit
- Harness drift becomes visible without manual inspection
- Repeated failure patterns can be turned into concrete next actions

## How to update this roadmap

After each harness-related improvement:

1. Update `Last updated`
2. Move the affected checklist item to `doing`, `done`, or `deferred`
3. Replace `Latest completed milestone`
4. Replace `Next recommended milestone`
5. Add one short entry to the update log with:
   - date
   - change
   - evidence
   - next action

## Update log

### 2026-03-24

- Change: Added native `OPENCLAW.md` support to bootstrap loading, subagent allowlist, sandbox seed, docs, and local display-marked runtime.
- Evidence:
  - Source changes in `src/agents/workspace.ts` and `src/agents/sandbox/workspace.ts`
  - Targeted tests passed
  - Live workspace smoke test confirmed `OPENCLAW.md` was injected into the real system prompt
- Next action: Implement prompt budget breakdown and task profile schema

### 2026-03-24

- Change: Added prompt budget breakdown to `systemPromptReport` and `/context` output.
- Evidence:
  - Source changes in `src/agents/system-prompt-report.ts`, `src/auto-reply/reply/commands-context-report.ts`, and `src/config/sessions/types.ts`
  - Targeted tests passed
  - Live local-agent smoke test returned `promptBudget` in real output
- Next action: Implement task profile schema and workspace policy discovery

### 2026-03-24

- Change: Added first-class task profile reporting for `coding`, `research`, `ops`, and `assistant`.
- Evidence:
  - Source changes in `src/agents/task-profile.ts`, `src/agents/system-prompt-report.ts`, `src/auto-reply/reply/commands-context-report.ts`, and `src/config/sessions/types.ts`
  - Targeted tests passed
  - Live local-agent smoke test returned `systemPromptReport.taskProfile`
- Next action: Implement workspace policy discovery and policy slicing

### 2026-03-24

- Change: Added workspace policy discovery so OpenClaw can report bootstrap and candidate policy files beyond the fixed injected set.
- Evidence:
  - Source changes in `src/agents/workspace.ts`, `src/agents/system-prompt-report.ts`, `src/auto-reply/reply/commands-context-report.ts`, and `src/config/sessions/types.ts`
  - Targeted tests passed
  - Live local-agent smoke test returned `systemPromptReport.workspacePolicyDiscovery`
- Next action: Implement policy slicing

### 2026-03-24

- Change: Added policy slicing to runtime bootstrap injection, starting with excluding `HEARTBEAT.md` outside heartbeat runs and reporting sliced chars/files in `systemPromptReport` and `/context`.
- Evidence:
  - Source changes in `src/agents/pi-embedded-helpers/bootstrap.ts`, `src/agents/bootstrap-budget.ts`, `src/agents/system-prompt-report.ts`, and `src/auto-reply/reply/commands-context-report.ts`
  - Regression suite passed across bootstrap, budget, reporting, and system prompt paths
  - Live local-agent smoke test showed `policySlicing.totalSlicedChars = 543` and `workspaceInjectedChars` dropping from `5729` to `5186`
- Next action: Implement verify runner core

### 2026-03-24

- Change: Added verify runner core based on real `exec`/`bash` command outcomes, with verify results persisted in run/session metadata and surfaced in `/context`.
- Evidence:
  - Source changes in `src/agents/verify-report.ts`, `src/agents/pi-embedded-subscribe.handlers.tools.ts`, `src/auto-reply/reply/session-usage.ts`, and `src/auto-reply/reply/commands-context-report.ts`
  - Focused tests passed across tool handling, session persistence, and `/context` reporting
  - Build passed
  - Live local-agent smoke tests returned both failed and passed `meta.verifyReport` results for real `node --check` commands
- Next action: Implement structured failure reasons

### 2026-03-24

- Change: Added structured failure reasons so runs now classify failure state into categories like `verification`, `tool`, `context`, `timeout`, and `retry`, and persist that result into session metadata and `/context`.
- Evidence:
  - Source changes in `src/agents/failure-report.ts`, `src/agents/pi-embedded-runner/run.ts`, `src/auto-reply/reply/session-usage.ts`, and `src/auto-reply/reply/commands-context-report.ts`
  - Focused tests passed across failure classification, session persistence, and `/context` reporting
  - Build passed
  - Live local-agent smoke tests returned `meta.failureReport.status = none` on a passing verification run and preserved structured failure reporting in the latest local build
- Next action: Implement retry budget

### 2026-03-24

- Change: Added retry budget reporting so runs now persist retry count, retry causes, remaining budget, and exhausted state in run/session metadata and `/context`.
- Evidence:
  - Source changes in `src/agents/retry-report.ts`, `src/agents/pi-embedded-runner/run.ts`, `src/auto-reply/reply/session-usage.ts`, and `src/auto-reply/reply/commands-context-report.ts`
  - Focused tests passed across retry-report construction, session persistence, and `/context` rendering
  - Build passed
  - Live local-agent smoke test returned `meta.retryReport.status = unused` with `attemptsUsed = 1` and `remainingRetries = 31`
- Next action: Improve prompt/context report UX

### 2026-03-24

- Change: Improved prompt/context report UX so `/context` now highlights the largest prompt cost, largest injected workspace file, current attention state, and the next best leverage point, with the same summary available in `/context json`.
- Evidence:
  - Source changes in `src/auto-reply/reply/commands-context-report.ts`
  - Focused `/context` rendering tests passed
  - Build passed
- Next action: Implement profile-to-tool pack and profile-to-skill pack

### 2026-03-24

- Change: Added a prompt-aware default profile-to-tool pack so research, ops, and assistant runs start with narrower tool surfaces, while explicit tool profiles and allowlists still win.
- Evidence:
  - Source changes in `src/agents/task-profile-tool-pack.ts`, `src/agents/pi-tools.ts`, and `src/agents/pi-embedded-runner/run/attempt.ts`
  - Focused tests passed across task-profile inference, tool-pack resolution, and `createOpenClawCodingTools`
  - Build passed
  - Live local-agent smoke path logged `task-profile-tool-pack (research:minimal)` before hitting an unrelated existing session-file lock in the main session
- Next action: Implement profile-to-skill pack

### 2026-03-25

- Change: Added a prompt-aware default profile-to-skill pack so research, ops, and assistant runs inject smaller skill sets while preserving explicit skill filters and `always` skills.
- Evidence:
  - Source changes in `src/agents/task-profile-skill-pack.ts`, `src/agents/skills/workspace.ts`, and `src/agents/pi-embedded-runner/run/attempt.ts`
  - Focused tests passed across skill filtering, skills prompt rebuilding, and task-profile-driven runtime selection
  - Build passed
  - Live local-agent smoke test returned `taskProfile.id = research` with only `clawhub` and `weather` in `systemPromptReport.skills.entries`, and `skillsPromptChars = 1212`
- Next action: Implement dynamic tool pruning

### 2026-03-25

- Change: Added dynamic tool pruning so prompt-shaped runs remove obviously irrelevant web, messaging, ops, and read-only mutation tools after profile-based tool selection, and report the removed schema cost in `/context`.
- Evidence:
  - Source changes in `src/agents/dynamic-tool-pruning.ts`, `src/agents/pi-tools.ts`, `src/agents/system-prompt-report.ts`, and `src/auto-reply/reply/commands-context-report.ts`
  - Focused tests passed across pruning rules, runtime tool creation, system prompt reporting, and `/context` rendering
  - Build passed
  - Live local-agent smoke test returned `toolPruning.prunedCount = 5` with `prunedSchemaChars = 3052` for a read-only coding run
- Next action: Implement dynamic skill pruning

### 2026-03-25

- Change: Added dynamic skill pruning so prompt-shaped runs remove obviously irrelevant weather, ops, and skill-authoring skills after profile-based skill selection, and report the removed skill-block cost in `/context`.
- Evidence:
  - Source changes in `src/agents/dynamic-skill-pruning.ts`, `src/agents/skills/workspace.ts`, `src/agents/system-prompt-report.ts`, and `src/auto-reply/reply/commands-context-report.ts`
  - Focused tests passed across skill pruning rules, skills prompt rebuilding, system prompt reporting, and `/context` rendering
  - Build passed
  - Live local-agent smoke test returned `skillPruning.prunedCount = 3` with `prunedBlockChars = 1809`, leaving only `clawhub` in `systemPromptReport.skills.entries`
- Next action: Implement delegation profile

### 2026-03-25

- Change: Added delegation profile reporting so runs now expose session role, control scope, inherited workspace, requester/task context, and delegation-tool availability directly in `systemPromptReport` and `/context`.
- Evidence:
  - Source changes in `src/agents/delegation-profile.ts`, `src/agents/system-prompt-report.ts`, and `src/auto-reply/reply/commands-context-report.ts`
  - Focused tests passed across delegation-profile construction, system prompt reporting, and `/context` rendering
  - Build passed
  - Live local-agent smoke test returned `delegationProfile.role = main` with explicit `delegationToolsAllowed` and `delegationToolsBlocked`
- Next action: Implement failure-to-rule suggestions

### 2026-03-25

- Change: Added failure-to-rule suggestions so `/context` now turns structured verification, retry, tool, context, and prompt-budget signals into candidate policy guidance with concrete evidence.
- Evidence:
  - Source changes in `src/agents/failure-rule-suggestions.ts` and `src/auto-reply/reply/commands-context-report.ts`
  - Focused tests passed across rule suggestion generation and `/context` rendering
  - Build passed
  - Live local-agent smoke test produced real `verifyReport`, `failureReport`, and `retryReport` signals for a failing verification run, which now feed the new suggestion path
- Next action: Implement cron health checks

### 2026-03-25

- Change: Added cron health checks so `/context` now produces a schedulable isolated cron-check plan with cadence, focus areas, rationale, and a concrete health-review prompt.
- Evidence:
  - Source changes in `src/agents/cron-health-checks.ts` and `src/auto-reply/reply/commands-context-report.ts`
  - Focused tests passed across cron health-check suggestion generation, failure-rule suggestions, and `/context` rendering
  - Build passed
  - Gateway restart and health check passed on the local runtime
- Next action: Core harness roadmap complete; continue refining heuristics from live runs

### 2026-03-25

- Change: Refined runtime task-profile tool packs so generated allowlists are constrained to tools that are actually available in the current runtime/provider/model, eliminating noisy false-positive warnings during live runs.
- Evidence:
  - Source changes in `src/agents/task-profile-tool-pack.ts` and `src/agents/pi-tools.ts`
  - Focused tests passed across task-profile pack constraint logic and live warning suppression
  - Build passed
  - Live local-agent smoke test completed without the earlier `task-profile-tool-pack ... unknown entries` warning
- Next action: Continue tightening live heuristics and reporting quality from real runs

### 2026-03-25

- Change: Added a Chinese comparison checklist against OpenAI's harness engineering article, including current-state mapping, gaps, and prioritized post-roadmap Todo items.
- Evidence:
  - New document at `docs/zh-CN/concepts/harness-engineering-checklist.md`
  - Checklist covers `已满足 / 部分满足 / 未满足 / 刻意暂缓` and turns the remaining gaps into concrete follow-up work
- Next action: Use the checklist as the post-roadmap backlog for repo knowledge, policy write-back, cron automation, and architecture enforcement

### 2026-03-25

- Change: Closed the checklist's P0 and P1 backlog by making `CLAUDE.md` a first-class workspace policy file, adding explicit policy write-back and cron-install flows, and creating repo knowledge index / execution-plan / tech-debt docs with ownership metadata.
- Evidence:
  - Source changes in `src/agents/workspace.ts`, `src/agents/policy-writeback.ts`, `src/agents/cron-health-check-install.ts`, and `src/auto-reply/reply/commands-context-report.ts`
  - New docs at `docs/concepts/docs-index.md`, `docs/exec-plans/README.md`, `docs/exec-plans/harness-agent-first-system.md`, `docs/tech-debt/README.md`, and `docs/tech-debt/harness-platform-gaps.md`
  - Updated runtime docs for workspace/system prompt/bootstrap behavior now mention `CLAUDE.md` and richer workspace-policy reporting
- Next action: Build doc/policy lint and structural architecture enforcement

### 2026-03-25

- Change: Completed the first P2 pass by adding machine-checkable harness-core boundaries, repo-knowledge metadata/naming guards, and security-audit remediation enforcement.
- Evidence:
  - New scripts at `scripts/check-harness-core-boundaries.mjs`, `scripts/check-repo-knowledge-guards.mjs`, and `scripts/check-security-audit-remediation.mjs`
  - New regression tests at `test/harness-core-boundaries.test.ts`, `test/repo-knowledge-guards.test.ts`, and `test/security-audit-remediation.test.ts`
  - `pnpm check` now runs `lint:harness:core-boundaries`, `lint:repo-knowledge`, and `lint:security:audit-remediation`
  - Guard rollout found real missing remediation text in security audit findings and those findings were fixed
- Next action: Build dashboard/trend reporting and expand structural lint coverage beyond the harness core slice

### 2026-03-25

- Change: Added a first-pass workspace health dashboard so `/context health` now aggregates workspace sessions into profile-level success/cost/runtime/retry summaries and compares the latest 7-day window against the previous one for prompt, failure, and retry signals.
- Evidence:
  - Source changes in `src/agents/workspace-health-dashboard.ts` and `src/auto-reply/reply/commands-context-report.ts`
  - Focused tests passed across workspace-health aggregation and `/context health` rendering/json output
  - Docs now mention `/context health` in `docs/concepts/context.md`, `docs/zh-CN/concepts/context.md`, `docs/reference/token-use.md`, and `docs/zh-CN/reference/token-use.md`
- Next action: Implement doc gardening / cleanup automation and continue broadening structural lint coverage

### 2026-03-25

- Change: Completed the remaining P3 item by adding doc-gardening suggestion/install flow, so `/context` now reports repo-knowledge freshness drift and `/context docs install` can schedule an isolated cleanup/gardening run.
- Evidence:
  - Source changes in `src/agents/doc-gardening.ts`, `src/agents/doc-gardening-install.ts`, and `src/auto-reply/reply/commands-context-report.ts`
  - Focused tests passed across doc-gardening detection, managed cron installation, and `/context` rendering
  - Docs now mention `/context docs install` in `docs/concepts/context.md` and `docs/zh-CN/concepts/context.md`
- Next action: Start P4 discovery for UI/browser visibility, observability query surfaces, and review/reverify automation

### 2026-03-25

- Change: Added an Anthropic long-running harness comparison doc and turned the existing role-scoped planner / builder / evaluator execution-plan work into an explicit P5 backlog.
- Evidence:
  - New document at `docs/zh-CN/concepts/anthropic-long-running-harness-checklist.md`
  - Updated `docs/zh-CN/concepts/harness-engineering-checklist.md` with a new P5 section for the role-scoped build loop
  - Updated docs indexes and current roadmap snapshot to point to `docs/exec-plans/role-scoped-build-loop.md` and `docs/exec-plans/role-scoped-build-loop-phase-1-backlog.md`
- Next action: Start P5 Phase 1 with role presets, build-run artifacts, role-aware spawn defaults, and verify-pack schema

### 2026-03-25

- Change: Landed P5 Phase 1 issue 1 by adding `planner / builder / evaluator` role presets as first-class runtime/session metadata.
- Evidence:
  - Source changes in `src/agents/subagent-capabilities.ts`, `src/agents/delegation-profile.ts`, `src/agents/subagent-spawn.ts`, `src/agents/tools/sessions-spawn-tool.ts`, and `src/config/sessions/types.ts`
  - `/context` delegation reporting now exposes `rolePreset`, `promptMode`, `toolBias`, `verificationPosture`, and `artifactWriteScope`
  - Focused tests passed across role-preset defaults, delegation reporting, system-prompt reporting, `/context`, and sessions_spawn schema coverage
  - Build passed
- Next action: Implement build-run artifact roots and schema-backed planner / builder / evaluator artifacts

### 2026-03-25

- Change: Landed P5 Phase 1 issue 2 by adding schema-backed build-run artifact roots, read/write helpers, and policy-discovery exclusions for `.openclaw/build-runs`.
- Evidence:
  - New module at `src/agents/build-runs.ts` with predictable repo-local/state-dir artifact resolution and schema-backed read/write helpers for `acceptance.json`, `verify-pack.json`, `build-report.json`, and `eval-report.json`
  - New regression coverage at `src/agents/build-runs.test.ts`
  - `src/agents/workspace.ts` now skips `.openclaw/build-runs` during workspace policy discovery
  - Focused tests passed across build-run artifacts, policy discovery, role presets, delegation reporting, system-prompt reporting, `/context`, and sessions_spawn schema coverage
  - Build passed
- Next action: Implement verify-pack schema support for exec / logs / report checks

### 2026-03-25

- Change: Landed P5 Phase 1 issue 3 by turning `planner / builder / evaluator` role presets into real spawn defaults instead of passive labels.
- Evidence:
  - `src/agents/pi-tools.policy.ts` now applies role-aware subagent tool surfaces while still letting explicit allowlists win
  - `src/agents/pi-embedded-runner/run/attempt.ts` now gives `builder` the standard coding prompt while planner/evaluator stay minimal
  - `src/agents/subagent-spawn.ts`, `src/agents/spawned-context.ts`, and `src/agents/tools/sessions-spawn-tool.ts` now carry `buildRunId / buildRunDir` into spawned sessions and child system prompts
  - `/context detail` delegation reporting now surfaces `buildRunId` and `buildRunDir`
  - Focused tests passed across tool policy resolution, spawned metadata normalization, delegation reporting, `/context`, sessions_spawn schema coverage, role-aware spawn behavior, and prompt-mode resolution
  - Build passed
- Next action: Implement verify-pack schema support for exec / logs / report checks
