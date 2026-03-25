---
name: feature-or-bugfix-with-tests-and-changelog
description: Workflow command scaffold for feature-or-bugfix-with-tests-and-changelog in openclaw.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /feature-or-bugfix-with-tests-and-changelog

Use this workflow when working on **feature-or-bugfix-with-tests-and-changelog** in `openclaw`.

## Goal

Implements a new feature or bugfix, always accompanied by relevant test updates and a CHANGELOG.md entry.

## Common Files

- `src/**/*.ts`
- `src/**/*.test.ts`
- `extensions/**/**/*.ts`
- `extensions/**/**/*.test.ts`
- `CHANGELOG.md`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Implement code changes in relevant source files (e.g., src/ or extensions/).
- Add or update corresponding test files (e.g., *.test.ts) in the same or related directory.
- Update CHANGELOG.md to document the change.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.