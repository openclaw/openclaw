---
summary: "Actionable Phase 1 issue backlog for landing the first planner-builder-evaluator slice in OpenClaw"
read_when:
  - You want to turn the role-scoped build-loop plan into immediately actionable implementation work
  - You are opening issues for planner, builder, evaluator role support
  - You need the smallest useful first slice rather than the full long-term roadmap
owner: "OpenClaw harness"
freshness: "monthly"
last_reviewed: "2026-03-25"
title: "Role-Scoped Build Loop Phase 1 Backlog"
---

# Role-Scoped Build Loop Phase 1 Backlog

## Goal

Turn the [Role-Scoped Build Loop](/exec-plans/role-scoped-build-loop) plan into a first implementation slice that is small enough to ship, but strong enough to produce a visible quality jump on long-running build tasks.

## Phase 1 definition

Phase 1 is complete when OpenClaw can do all of the following without introducing a new orchestration DSL:

- spawn a `planner`, `builder`, or `evaluator` run with explicit role defaults
- write and read stable build-loop artifacts under a known run directory
- execute a `verify-pack.json` with at least `exec`, `logs`, `report`, and one richer check kind
- surface the build-loop role and artifact state clearly enough that humans can debug the run

## Stop line

Do not start the loop runner or command-surface work until the issues in this file are complete.

That stop line matters because OpenClaw already has a strong control plane. The risk now is building a user-facing workflow before the role model and evaluator semantics are reliable.

## Recommended issue order

1. `roles/role-preset-schema`
2. `build-runs/artifact-root-and-schemas`
3. `delegation/role-aware-spawn-defaults`
4. `verify/verify-pack-schema`
5. `verify/browser-evaluator-pack`
6. `docs/manual-role-scoped-build-walkthrough`

## Issue 1: `roles/role-preset-schema`

**Title**

`runtime: add planner / builder / evaluator role presets for delegated build work`

**Why**

OpenClaw already has task profiles and delegation reporting, but it does not yet have reusable role semantics for long-running build loops. Without role presets, every build-loop spawn will keep reinventing tool scope, prompt mode, and expected behavior.

**Goal**

Define a small role-preset model for `planner`, `builder`, and `evaluator`.

**Scope**

- add role-preset identifiers
- define per-role defaults for:
  - prompt mode
  - tool bias
  - verification posture
  - artifact write permissions
- expose the selected role preset in runtime reporting

**Non-goals**

- no build-loop runner
- no contract negotiation engine
- no new task profiles

**Likely files**

- `src/agents/delegation-profile.ts`
- `src/agents/subagent-capabilities.ts`
- `src/agents/system-prompt-params.ts`
- `src/auto-reply/reply/commands-context-report.ts`
- `src/agents/delegation-profile.test.ts`

**Deliverables**

- role-preset type and defaults
- tests for preset resolution
- `/context` reporting update that makes the preset explicit

**Acceptance criteria**

- a delegated run can declare `planner`, `builder`, or `evaluator`
- `/context list` shows the selected role preset clearly
- role presets are distinct from task profiles rather than overloading them
- existing non-build delegation keeps working

**Depends on**

- none

## Issue 2: `build-runs/artifact-root-and-schemas`

**Title**

`runtime: add build-run artifact root plus schema-backed planner / builder / evaluator artifacts`

**Why**

The role loop only becomes durable when state leaves the prompt and lands in stable artifacts. Without that, the build loop remains chat choreography.

**Goal**

Create a stable artifact root and minimal schema set for planner, builder, and evaluator outputs.

**Scope**

- define a build-run root path
- define artifact names and JSON schemas for:
  - `acceptance.json`
  - `verify-pack.json`
  - `build-report.json`
  - `eval-report.json`
- add helpers to resolve, write, and read these artifacts
- ensure repo-local artifact paths are predictable and safe

**Non-goals**

- no automatic loop runner
- no schema for every future pack kind
- no artifact sync to memory or chat history

**Likely files**

- `src/agents/workspace.ts`
- `src/agents/workspace-dir.ts`
- `src/agents/workspace-run.ts`
- `src/agents/context.ts`
- new module such as `src/agents/build-runs.ts`
- tests near `src/agents/workspace-run.test.ts`

**Deliverables**

- build-run path resolver
- schema validators
- read/write helper layer
- docs note on repo-local artifact location

**Acceptance criteria**

- repo workspaces write artifacts under `.openclaw/build-runs/<run-id>/`
- non-repo workspaces write artifacts under a stable state-dir fallback
- artifact helpers reject malformed JSON payloads with useful errors
- artifact roots do not get accidentally treated as workspace policy files

**Depends on**

- `roles/role-preset-schema`

## Issue 3: `delegation/role-aware-spawn-defaults`

**Title**

`delegation: apply role presets to spawned runs with bounded default tool surfaces`

**Why**

Role presets only matter if spawn paths honor them. The runtime must turn `planner`, `builder`, and `evaluator` into concrete execution defaults instead of passive labels.

**Goal**

Make subagent spawning role-aware.

**Scope**

- allow spawn requests to carry a role preset
- map each role to default tool surfaces and prompt mode
- make explicit allowlists and user policy override defaults
- carry build-run artifact references into spawned context

**Non-goals**

- no multi-model routing system
- no fully automated planner->builder->evaluator loop
- no new permission model beyond current sandbox and allowlist rules

**Likely files**

- `src/agents/subagent-spawn.ts`
- `src/agents/spawned-context.ts`
- `src/agents/subagent-registry.ts`
- `src/agents/tools/subagents-tool.ts`
- `src/agents/subagent-capabilities.ts`
- `src/agents/openclaw-tools.subagents.*.test.ts`

**Deliverables**

- role-aware spawn parameters
- role-to-tool-surface resolution
- tests covering override precedence

**Acceptance criteria**

- `planner` defaults to read-heavy, non-editing behavior
- `builder` defaults to edit/write/exec behavior
- `evaluator` defaults to read/exec/browser/log inspection behavior
- `/context` or equivalent run reporting can explain the applied role defaults
- explicit workspace or user allowlists still win

**Depends on**

- `roles/role-preset-schema`
- `build-runs/artifact-root-and-schemas`

## Issue 4: `verify/verify-pack-schema`

**Title**

`verify: add verify-pack artifact support for exec / logs / report checks`

**Why**

OpenClaw already has a strong verify runner, but it is not yet driven by a portable artifact that planner and evaluator can share. `verify-pack.json` is the bridge between today's generic verify and the future evaluator loop.

**Goal**

Add a `verify-pack.json` contract and execute a small first set of check kinds.

**Scope**

- define `verify-pack.json` schema
- support `exec` checks
- support `logs` checks
- support `report` checks for artifact presence and basic field validation
- persist results into existing verify / failure / retry reporting

**Non-goals**

- no browser checks yet in this issue
- no DB-specific evaluator logic yet
- no standalone second verify system

**Likely files**

- `src/agents/verify-report.ts`
- `src/agents/failure-report.ts`
- `src/agents/retry-report.ts`
- `src/agents/system-prompt-report.ts`
- `src/auto-reply/reply/commands-context-report.ts`
- new module such as `src/agents/verify-pack.ts`

**Deliverables**

- verify-pack schema
- runner support for `exec`, `logs`, `report`
- failure-category integration
- tests for passing and failing packs

**Acceptance criteria**

- a valid `verify-pack.json` can be loaded from a build-run artifact root
- failing checks produce structured failure output through the existing failure path
- `/context` reporting continues to use the same verify / failure / retry surfaces
- malformed verify packs fail clearly before execution

**Depends on**

- `build-runs/artifact-root-and-schemas`

## Issue 5: `verify/browser-evaluator-pack`

**Title**

`verify: add browser-backed evaluator checks for navigation, visibility, action, and screenshot evidence`

**Why**

This is the first issue that should make OpenClaw feel meaningfully closer to Anthropic's evaluator pattern. Browser checks are where builder self-report most often diverges from real user-visible behavior.

**Goal**

Add a first richer evaluator pack using the existing browser tool and browser runtime.

**Scope**

- extend verify-pack support with `browser` checks
- support a small initial action set:
  - navigate
  - assert visible text or element
  - click or form action
  - optional screenshot capture for evidence
- record structured evidence in evaluator output

**Non-goals**

- no broad Playwright DSL
- no visual design scoring rubric yet
- no generalized autonomous browsing planner

**Likely files**

- `src/agents/tools/browser-tool.ts`
- `src/agents/tools/browser-tool.actions.ts`
- `src/agents/tools/browser-tool.schema.ts`
- `src/browser/routes/agent.act.ts`
- `src/browser/routes/agent.snapshot.ts`
- `src/browser/screenshot.ts`
- verify-pack integration files from Issue 4

**Deliverables**

- `browser` verify-pack kind
- structured browser-check result shape
- screenshot or snapshot evidence path when available
- focused tests around navigation, assertion, and failure reporting

**Acceptance criteria**

- a browser check can open a local app URL and verify a primary UI condition
- browser failures produce structured evaluator output rather than raw browser logs only
- when screenshot support is available, evaluator output records the evidence path
- browser checks respect current sandbox and tool policy

**Depends on**

- `verify/verify-pack-schema`
- `delegation/role-aware-spawn-defaults`

## Issue 6: `docs/manual-role-scoped-build-walkthrough`

**Title**

`docs: add a manual role-scoped build walkthrough with example artifacts and stop conditions`

**Why**

Before a loop runner exists, humans and agents need a repo-native recipe they can follow. This issue is what turns the first five implementation issues into a usable working method.

**Goal**

Document the manual build-loop workflow end to end.

**Scope**

- add a walkthrough showing:
  - planner artifact creation
  - builder execution against those artifacts
  - evaluator run against `verify-pack.json`
  - stop conditions and retry budget use
- include sample artifact payloads
- link to the relevant runtime docs and `/context` inspection surfaces

**Non-goals**

- no new user-facing command
- no benchmark report yet
- no auto-install flow

**Likely files**

- `docs/exec-plans/role-scoped-build-loop.md`
- new concept or how-to doc under `docs/concepts/` or `docs/tools/`
- `docs/concepts/docs-index.md`

**Deliverables**

- walkthrough doc
- example artifact snippets
- guidance on when not to use the role-scoped loop

**Acceptance criteria**

- a new agent or teammate can follow the doc without needing extra chat context
- the walkthrough uses the real artifact names and real role names from Phase 1
- the doc makes the stop line explicit: no loop runner required for the first workflow

**Depends on**

- issues 1 through 5

## Suggested milestone boundaries

### Milestone A

- Issue 1
- Issue 2
- Issue 3

**Expected outcome**

OpenClaw can spawn role-aware build work and persist the right artifacts, even before richer evaluator checks land.

### Milestone B

- Issue 4
- Issue 5

**Expected outcome**

OpenClaw can execute a reusable evaluator contract that is stronger than builder self-report.

### Milestone C

- Issue 6

**Expected outcome**

The Phase 1 workflow is usable by humans and agents without waiting for a loop runner.

## Explicitly deferred to Phase 2

- build-loop runner
- round ledger UX
- dedicated slash command or CLI command
- contract negotiation between builder and evaluator
- design-rubric scoring
- DB-specific evaluator pack
- review->reverify->merge automation

## Success signal for this backlog

This backlog has succeeded when a real OpenClaw run can do the following:

1. create planner artifacts
2. spawn a builder with role-aware defaults
3. execute a verify pack with at least one browser-backed check
4. return structured evaluator findings through the existing harness reporting path
5. stop within the current retry-budget model instead of inventing a second control loop
