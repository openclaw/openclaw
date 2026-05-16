---
name: ff_create_plan
description: Create an actionable implementation plan from a Fastflow goal, research, and Codex subagent findings
---

# Create Implementation Plan

Create a practical implementation plan for the provided goal. Fastflow runs Codex with multi-agent support enabled by default, so mirror the Claude planning flow by using subagents for independent research and option analysis when useful. Also invoke repository-provided Codex skills when they apply.

## Operating Rules

- Read the goal file and any referenced research or ticket files first.
- Inspect the actual code before deciding on an approach.
- Use subagents for independent, bounded discovery tasks; keep final architecture and plan synthesis local.
- Ask for clarification only when the repository and available skills cannot answer a decision that blocks implementation.
- Plans must be actionable by a fresh agent with no hidden context.
- Include concrete file paths, expected changes, verification commands, and PR/branch notes when relevant.
- Do not leave open questions in the final plan.

## Subagent Pattern

Good planning subagent tasks are specific and read-only:

- "Find existing implementation patterns for {capability}. Return file references, test patterns, and constraints. Do not edit files."
- "Analyze the likely data/API/UI impact of {change}. Return risks and affected files. Do not edit files."
- "Inspect validation/build/test commands for this repo. Return the commands a worker should run. Do not edit files."

Avoid delegating the whole plan. Wait for subagents before finalizing, then verify the important facts yourself.

## Process

1. Read the goal file fully.
2. Read matching research from thoughts/shared/research/ when available.
3. Search the repo for related code, tests, configs, docs, and existing patterns.
4. Spawn subagents for independent research slices when the task has multiple areas or uncertain scope.
5. Decide the smallest safe implementation approach that satisfies the goal.
6. Write the plan under thoughts/shared/plans/.

## Plan Format

Create a file named like:

`thoughts/shared/plans/YYYY-MM-DD-{ticket-or-topic}.md`

Use this structure:

```markdown
# {Feature Or Fix} Implementation Plan

## Goal

{what this plan accomplishes}

## Current State

{relevant existing behavior, with file references}

## Desired End State

{observable outcome after implementation}

## Out Of Scope

{explicit non-goals}

## Subagent Findings Used

{subagent summaries used, or "None"}

## Implementation Steps

### Step 1: {name}

- Files: `path/to/file`, `path/to/test`
- Change: {specific change}
- Notes: {constraints or existing patterns}

### Step 2: {name}

- Files: ...
- Change: ...

## Verification

- `command to run` - expected result
- Manual check: {only if automation is not enough}

## Branch And PR Notes

{branch protection, PR strategy, or "None"}

## Risks

- {risk and mitigation}
```

## Completion

Finish by printing the plan file path and a short summary of the implementation strategy.
