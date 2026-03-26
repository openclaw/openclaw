---
summary: "Thin plan for adding a planner-builder-evaluator build recipe on top of OpenClaw's existing harness control plane"
read_when:
  - You want to land an Anthropic-style planner/generator/evaluator loop in OpenClaw without building a heavy orchestration DSL
  - You are planning long-running app-building or repo-building flows
  - You need a durable comparison between OpenClaw's current harness core and the next task-level loop to add
owner: "OpenClaw harness"
freshness: "monthly"
last_reviewed: "2026-03-25"
title: "Role-Scoped Build Loop"
---

# Role-Scoped Build Loop

## Goal

Add a thin, role-scoped build recipe that turns OpenClaw's existing harness control plane into a repeatable long-running build loop for app and repo work.

The target shape is inspired by Anthropic's `planner -> generator -> evaluator` pattern, but adapted to OpenClaw's current architecture:

- keep the existing harness core
- add the smallest useful role loop on top
- prefer artifacts and role presets over a new orchestration DSL

See also:

- [Role-Scoped Build Loop Phase 1 Backlog](/exec-plans/role-scoped-build-loop-phase-1-backlog)

## Why this plan exists

OpenClaw already has most of the harness control-plane pieces that Anthropic's article says matter:

- prompt budget reporting
- task profiles
- workspace policy discovery and slicing
- verify / failure / retry reporting
- tool and skill pruning
- delegation profile reporting
- failure-to-rule suggestions
- cron health-check suggestion and install

What OpenClaw does not yet have is a first-class task recipe for long-running build work with explicit roles, role-scoped outputs, and an evaluator that behaves like QA instead of generic post-hoc verification.

That gap matters because the next quality jump is unlikely to come from more prompt mass. It is more likely to come from:

- planning artifacts before coding
- stronger evaluator packs
- role-specific tool surfaces
- bounded build-evaluate loops with clean handoff artifacts

## Current baseline vs next addition

| Area                        | OpenClaw today                                                                 | What this plan adds                                                                         |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Prompt and context control  | Strong: task profiles, prompt budget, policy slicing, dynamic pruning          | Reuse as-is; do not rebuild                                                                 |
| Verification                | Strong for command-style verify and structured failure capture                 | Add richer evaluator packs for browser, API, DB, logs, screenshots, and report-based checks |
| Delegation                  | Strong reporting and explainability for subagents                              | Add fixed role presets: planner, builder, evaluator                                         |
| Governance                  | Strong single-run visibility plus rule suggestions and cron health suggestions | Reuse as-is; feed richer evaluator results into the same loop                               |
| Long-running build workflow | Weak: no first-class planner artifact, contract artifact, or evaluator loop    | Add a task recipe with explicit artifacts and bounded rounds                                |

## Product decision

Do not start with a new general-purpose orchestration framework.

Start with a `build-app` style recipe that uses:

- existing task profiles
- existing delegation machinery
- existing `/context` reporting
- existing verify / failure / retry contracts
- new role presets
- new artifact schemas
- new evaluator packs

Only promote this to a broader runtime command surface if the recipe proves useful in real build tasks.

## Proposed architecture

### 1. Planner

The planner turns a short user prompt into a concrete build target.

**Input**

- user request
- repo/workspace context
- relevant workspace policy files
- current task profile

**Default tool surface**

- `read`
- `rg`-style repo search
- local docs access
- optional lightweight web lookup when explicitly needed

**Default constraints**

- no code edits
- no long-running commands
- focus on product shape, acceptance, and verification strategy
- avoid locking in low-level implementation details too early

**Outputs**

- `spec.md`
- `acceptance.json`
- `verify-pack.json`
- `delegation.json`
- optional `risks.md`

### 2. Builder

The builder implements against the planner artifacts.

**Input**

- `spec.md`
- `acceptance.json`
- `verify-pack.json`
- `delegation.json`
- workspace policy context

**Default tool surface**

- edit/write tools
- `exec`
- file reads
- repo-local search

**Default constraints**

- work in bounded chunks
- report intended verification before claiming success
- hand off after each build round instead of endlessly self-extending scope

**Outputs**

- `build-report.json`
- `changed-files.md`
- `verify-intent.json`
- optional `known-gaps.md`

### 3. Evaluator

The evaluator behaves like QA and code review, not like a polite self-summary.

**Input**

- planner artifacts
- builder outputs
- live workspace/runtime state
- verify packs

**Default tool surface**

- `read`
- `exec`
- browser and screenshot tooling when available
- API and DB checks when available
- log inspection

**Default constraints**

- prefer finding disconfirming evidence over praising the build
- do not edit code in the MVP
- fail the round if any blocking criterion fails

**Outputs**

- `eval-report.json`
- `findings.md`
- `retry-advice.json`
- optional `rule-candidate-hints.json`

## Proposed artifact model

Default artifact root:

- repo workspaces: `<repo>/.openclaw/build-runs/<run-id>/`
- non-repo workspaces: `~/.openclaw/build-runs/<workspace-slug>/<run-id>/`

These artifacts should be gitignored by default in repo workspaces.

### `acceptance.json`

Keep this intentionally small.

Suggested shape:

```json
{
  "goal": "High-level outcome",
  "in_scope": ["..."],
  "out_of_scope": ["..."],
  "blocking_checks": [
    {
      "id": "core-flow-works",
      "description": "Primary user flow works end to end",
      "kind": "functional"
    }
  ],
  "quality_bars": {
    "functionality": "required",
    "design": "important",
    "code_quality": "important"
  }
}
```

### `verify-pack.json`

This is the most important new structure because it bridges current OpenClaw verify and Anthropic-style evaluator behavior.

Suggested shape:

```json
{
  "checks": [
    {
      "id": "typecheck",
      "kind": "exec",
      "blocking": true,
      "command": "pnpm typecheck"
    },
    {
      "id": "app-home-renders",
      "kind": "browser",
      "blocking": true,
      "url": "http://127.0.0.1:3000",
      "expectation": "Main landing page renders and primary CTA is visible"
    },
    {
      "id": "api-health",
      "kind": "api",
      "blocking": true,
      "request": {
        "method": "GET",
        "url": "http://127.0.0.1:8000/health"
      },
      "expect": {
        "status": 200
      }
    }
  ]
}
```

### `build-report.json`

Suggested shape:

```json
{
  "round": 1,
  "summary": "What was implemented",
  "commands_run": ["pnpm test", "pnpm dev"],
  "files_changed": ["src/app.tsx", "src/api/server.ts"],
  "known_gaps": ["No browser QA yet on settings page"]
}
```

### `eval-report.json`

Suggested shape:

```json
{
  "status": "fail",
  "round": 1,
  "checks_run": 5,
  "checks_passed": 3,
  "blocking_findings": [
    {
      "id": "save-flow-broken",
      "kind": "browser",
      "summary": "Save button is visible but does not persist changes",
      "failure_category": "verification"
    }
  ],
  "next_action": "builder_retry"
}
```

## How this maps to existing OpenClaw capabilities

### Keep and reuse

- **Task profiles** stay the outer intent layer.
- **Workspace policy discovery and slicing** stay the bootstrap layer.
- **Prompt budget reporting** stays the observability layer.
- **Structured failure** stays the canonical failure taxonomy.
- **Retry budget** stays the global loop brake.
- **Failure-to-rule suggestions** stay the governance path after repeated failures.
- **Cron health checks** stay the long-term hygiene path.

### Extend

- **Delegation profile** grows from "who spawned whom" into role presets with clearer default tool scopes.
- **Verify runner** grows from command-heavy verification into evaluator packs with more check kinds.
- **`/context`** should eventually report role-loop artifacts, current round, and top blocking findings.

### Do not duplicate

Do not create a second verification system, second retry model, or second failure taxonomy just for the build loop.

The build recipe should write into the existing harness reporting model wherever possible.

## Role presets

These are not new task profiles. They are narrower role presets nested inside a task profile such as `coding`.

### `planner`

- tool bias: read-only
- prompt mode: minimal plus planning artifacts
- verification: none
- writes: artifacts only

### `builder`

- tool bias: edit, write, exec
- prompt mode: standard coding
- verification: builder can run local sanity checks but not act as final judge
- writes: code plus build artifacts

### `evaluator`

- tool bias: read, exec, browser, logs, API, DB
- prompt mode: minimal plus planner and builder artifacts
- verification: authoritative for pass/fail in the loop
- writes: evaluator artifacts only

## Evaluator packs

This is the most important product addition after artifacts.

### MVP packs

- `exec`
- `logs`
- `report`

### Next packs

- `browser`
- `api`
- `db`
- `screenshot`

### Later packs

- `design-rubric`
- `accessibility`
- `migration`
- `security-smoke`

The design principle is simple:

- if the signal can be checked deterministically, make it a verify check
- if the signal is more judgment-heavy, make it an evaluator rubric

## Contracting strategy

Anthropic's sprint-contract negotiation is valuable, but it should not be the first thing OpenClaw builds.

### MVP

Use a planner-authored acceptance contract up front:

- planner defines target and checks
- builder implements against it
- evaluator tests against it

### V2

Allow builder to propose a narrower round contract:

- planner defines global spec
- builder proposes round scope and verify plan
- evaluator accepts or revises before the round starts

This preserves most of the value without forcing a full negotiation engine into the first release.

## Rollout plan

### Phase 0. Documented recipe

Ship this first as a documented recipe plus artifact conventions.

**Deliverables**

- this exec plan
- artifact schemas
- role-preset definitions
- one example long-running build walkthrough

**Exit signal**

- a human or agent can run the loop manually without inventing the structure from scratch

### Phase 1. Role-scoped delegation presets

Add first-class preset support for:

- `planner`
- `builder`
- `evaluator`

**Deliverables**

- role preset config surface
- default tool scopes per role
- role visibility in runtime reporting

**Exit signal**

- a delegated run can clearly say which role it is playing and why

### Phase 2. Evaluator-pack support

Extend verify to support richer check kinds.

**Deliverables**

- `verify-pack.json` schema
- exec/log/report support
- browser/API/DB follow-up support

**Exit signal**

- evaluator results are materially stronger than builder self-report

### Phase 3. Loop runner

Add a thin runner that manages planner -> builder -> evaluator rounds.

**Deliverables**

- run directory creation
- round ledger
- max-round and retry integration
- resume support

**Exit signal**

- OpenClaw can complete a bounded build loop without bespoke manual orchestration each time

### Phase 4. Promote only if justified

Only after repeated successful use:

- add a dedicated slash command or CLI entrypoint
- add richer `/context` inspection for build-loop state
- add promotion into cron or health workflows where useful

## Suggested command-surface policy

Do not add a top-level runtime command in Phase 0 or Phase 1.

Preferred order:

1. documented recipe
2. runtime role presets
3. evaluator-pack support
4. thin loop runner
5. user-facing command only if the recipe becomes common

This keeps OpenClaw aligned with its own roadmap principle: solve the task with the smallest durable abstraction first.

## Success metrics

- long-running build tasks create planner artifacts before code changes begin
- evaluator catches failures that builder self-report missed
- build loops stop within a bounded retry budget
- normal non-build runs do not pay meaningful extra prompt cost
- browser/API-style checks measurably improve first-pass usability on app-building tasks

## Non-goals

- no heavy orchestration DSL
- no mandatory multi-agent loop for ordinary coding tasks
- no broad model-routing platform as a prerequisite
- no auto-merge or release automation in the MVP
- no second policy or second failure system outside the existing harness core

## Recommended first implementation slice

If only one thin slice is funded first, do this:

1. add `planner`, `builder`, and `evaluator` role presets
2. add repo-local artifact conventions
3. extend verify with `report` plus one richer pack such as `browser` or `api`

That slice is the smallest version that creates a real quality jump over today's generic coding flow.

## Why this is the right next move

OpenClaw does not need another round of generic harness thickening.

It needs one strong task recipe that proves the existing control plane can support:

- planned build work
- skeptical evaluation
- bounded retries
- durable handoff artifacts

If that works, OpenClaw will have crossed an important line:

from a strong harness runtime

to a stronger agent-first build system.
