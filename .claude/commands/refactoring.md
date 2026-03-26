---
name: refactoring
description: Workflow command scaffold for refactoring in openclaw.
allowed-tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /refactoring

Use this workflow when working on **refactoring** in `openclaw`.

## Goal

Code refactoring and cleanup workflow

## Common Files

- `src/**/*`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Ensure tests pass before refactor
- Refactor code structure
- Verify tests still pass

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.
