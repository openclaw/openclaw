# SKILL.md - Reusable Task Cadence

## Purpose

Capture repetitive work as durable skills so the same request does not require repeated user instruction.

## Scope

Use this for work that is likely to recur, whether operational (cleanup, audits), project hygiene, or recurring investigations.

## Workflow

1. **Concept**
   - Clarify intended outcome and boundaries.
   - Decide whether this is one-off or recurring infrastructure.

2. **Prototype**
   - Run the work manually on a fresh batch of 3-10 real items.
   - Collect concrete output (logs, diffs, checks).

3. **Evaluate**
   - Review results with the user.
   - Capture what should change before codifying.

4. **Codify**
   - Add or extend a single owning SKILL.md under `workspace/skills/`.
   - Enforce a strict MECE split:
     - each type of work has one owner skill
     - no overlapping responsibilities
     - no missing coverage

5. **Cron**
   - If recurring, add a cron schedule via `openclaw cron add` for exact timing or standalone execution.

6. **Monitor**
   - Verify first runs.
   - Iterate on failure modes and adjust skill or schedule.

## MECE Rule

Before creating a new skill, scan `workspace/skills/*/SKILL.md` first and extend existing skill scope where possible.

## Notes

- One-off asks are still executed immediately, but recurring ones should be promoted toward this cycle.
- Keep skill files minimal, actionable, and aligned with current workspace truth.
