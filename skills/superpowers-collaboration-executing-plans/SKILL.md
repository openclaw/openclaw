---
name: superpowers-collaboration-executing-plans
description: Execute a written implementation plan in controlled batches with verification and checkpoints. Use when the user provides or approves a plan and wants disciplined execution instead of ad hoc coding.
---

# Executing Plans

Treat the plan as an execution contract, but review it critically before starting.

This skill is for multi-step work where sequencing matters. The point is to preserve momentum without turning the plan into blind cargo-cult instructions.

## Step 1: Review The Plan Before Coding

Read the full plan first.

Check for:

- missing or impossible file paths
- commands that do not fit this repo
- unclear sequencing
- gaps in verification
- tasks that are too large to execute safely

If the plan has material problems, stop and raise them before implementing.

## Step 2: Execute In Batches

Default to small batches, typically 1-3 tasks depending on risk.

For each task:

1. mark the active task clearly in your own progress tracking
2. follow the intended sequence
3. run the verification listed for that task
4. confirm the task is actually complete before moving on

Do not silently skip verification because the code "looks right".

## Step 3: Report Between Batches

At the end of each batch, report:

- what was implemented
- what verification ran
- any deviations from the plan
- any blockers or newly discovered risks

Then either continue, request feedback, or revise the plan depending on the workflow.

## Step 4: Handle Reality Changes

Plans are allowed to be wrong. Do not force execution through new facts.

Stop and reassess when:

- a task depends on incorrect assumptions
- a listed command fails for environmental or repo-specific reasons
- verification reveals a broader issue than the plan anticipated
- the next step would require guessing

At that point, either update the plan or ask the user how they want to proceed.

## Step 5: Finish Cleanly

When all tasks are done:

- run the final verification gate from the plan
- summarize completed work against the original goal
- call out any remaining risks or skipped items explicitly

If further review is warranted, request it before treating the plan as complete.

## Repo-Specific Guidance

For this repo, typical execution gates include:

- `pnpm test -- <target>`
- `pnpm build`
- `pnpm check`
- `pnpm tsgo`

Use the narrowest command that proves each step, then the broader gate at the end.

If the plan touches docs, releases, channels, or platform-specific surfaces, carry forward the relevant `AGENTS.md` constraints instead of assuming the plan captured all of them.

## Red Flags

- starting implementation without reading the full plan
- doing a large unplanned refactor in the middle of a batch
- skipping an explicit verification step
- continuing after a blocker without updating the plan
- reporting progress without verification evidence

## Related Skills

- `skills/superpowers-collaboration-writing-plans/SKILL.md`
- `skills/superpowers-collaboration-requesting-code-review/SKILL.md`
- `skills/superpowers-testing-test-driven-development/SKILL.md`
