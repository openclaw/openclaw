---
name: superpowers-collaboration-writing-plans
description: Write an implementation plan that another engineer or future agent can execute with minimal extra context. Use when design is settled and the user wants a concrete step-by-step execution plan instead of immediate coding.
---

# Writing Plans

Write plans that are executable, not inspirational.

This skill is for the moment after design convergence and before implementation. The plan should assume the executor knows the codebase poorly and needs exact file paths, concrete commands, and verification steps.

## When To Use

Use this skill when:

- the user asks for a plan
- the work is large enough to benefit from sequencing
- the design is decided but implementation details still need to be broken down
- another agent or engineer is likely to execute the work later

Do not use this skill for trivial changes that should just be implemented.

## Plan Location

In this repo, save plans under:

- `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`

If the user only wants the plan in chat, you can draft it inline first, but prefer saving it when it will be reused.

## Core Standard

Each task should be small, testable, and independently understandable.

Aim for steps that are roughly one focused action each:

- add or update a failing test
- run the targeted command and observe the expected failure
- implement the smallest change
- rerun verification
- commit if the workflow calls for it

Avoid giant tasks like "implement feature" or "fix backend".

## Required Plan Header

Every saved plan should start with:

```md
# <Feature Name> Implementation Plan

**Goal:** <one sentence>

**Architecture:** <2-3 sentences on the chosen approach>

**Key Paths:**
- `path/to/main/file`
- `path/to/test`

**Verification:**
- `pnpm test -- <target>`
- `pnpm build`
```

Adjust the verification commands to match the actual area being changed.

## Task Template

Use this structure for each task:

```md
## Task N: <short title>

**Why:** <what this task accomplishes>

**Files:**
- Modify: `src/example.ts`
- Test: `src/example.test.ts`

**Steps:**
1. Add or update the failing test for `<behavior>`.
2. Run `pnpm test -- src/example.test.ts -t "<name>"` and confirm the failure matches the intended gap.
3. Implement the minimal production change in `src/example.ts`.
4. Re-run `pnpm test -- src/example.test.ts -t "<name>"`.
5. Run any adjacent verification needed for confidence.

**Done When:**
- the targeted test passes
- no neighboring behavior regresses
```

## What Good Plans Include

- Exact file paths.
- Specific commands, not "run tests".
- Expected outcomes for important verification steps.
- Notes about integration boundaries and risky assumptions.
- References to existing code paths that should be copied or matched.

## What Good Plans Avoid

- Placeholder steps like "implement logic".
- Vague phrases like "handle edge cases".
- Giant batches that mix unrelated work.
- Commands that are not valid for this repo.
- Telling the executor to infer missing context from memory.

## Repo-Specific Guidance

For this repository, prefer verification commands such as:

- `pnpm test -- <path-or-filter>`
- `pnpm build`
- `pnpm check`
- `pnpm tsgo`

If a narrower command is enough, use the narrowest command that still proves the step.

If the plan involves docs, note the relevant Mintlify or repo-specific constraints directly in the task instead of assuming the executor remembers them.

## Handoff

End the plan with a brief execution note:

- whether the tasks should be executed sequentially or can be parallelized
- the highest-risk integration point
- the final verification gate before merge

If the user wants execution next, proceed to implementation instead of repeating the plan.

## Related Skills

- `skills/superpowers-collaboration-brainstorming/SKILL.md`
- `skills/superpowers-debugging-systematic-debugging/SKILL.md`
- `skills/superpowers-testing-test-driven-development/SKILL.md`
