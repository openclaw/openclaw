---
name: superpowers-testing-test-driven-development
description: Drive implementation with failing tests first. Use when building a feature, changing behavior, or fixing a bug where a regression test is feasible.
---

# Test-Driven Development

Write the test first. Watch it fail for the right reason. Then write the smallest code that makes it pass.

This skill is about behavior-first implementation, not retroactive coverage.

## The Rule

No production change before a failing test, unless a test is genuinely infeasible and you explicitly explain why.

If you skipped the failing test, you are not doing TDD. You are writing code and adding tests later.

## When To Use

Use this skill for:

- new behavior
- bug fixes
- refactors that change behavior risk
- additions to parsers, routing, validation, adapters, and CLI output

If a regression test is hard to write, that is usually a design signal, not permission to skip testing.

## The Cycle

### 1. Red

Write one failing test for one behavior.

The test should:

- describe the behavior clearly
- exercise the real code path when feasible
- fail because the behavior is missing or incorrect

For this repo, prefer targeted Vitest runs through the wrapper:

```bash
pnpm test -- src/example.test.ts -t "describes the behavior"
```

### 2. Verify Red

Run the test and inspect the failure.

Confirm:

- it fails
- it fails for the intended reason
- it is not a typo, setup problem, or unrelated crash

If the test passes immediately, you learned something useful: either the behavior already exists or the test is wrong.

### 3. Green

Write the smallest production change that makes the test pass.

Do not:

- add extra features
- bundle refactors
- generalize early
- "clean up while here"

Minimal passing code first. Design cleanup comes later.

### 4. Verify Green

Run the targeted test again, then enough adjacent verification to trust the change.

Common commands in this repo:

```bash
pnpm test -- src/example.test.ts -t "describes the behavior"
pnpm build
```

Use narrower or broader verification based on the affected surface.

### 5. Refactor

Once behavior is green:

- remove duplication
- improve naming
- extract helpers
- keep tests green throughout

Refactor only after the behavior is protected.

## Good Test Properties

- One behavior per test.
- Clear names.
- Real assertions on user-visible or contract-visible behavior.
- Minimal mocking.

Be suspicious of tests that mostly verify mocks, call counts, or implementation trivia.

## Bug Fix Pattern

For bugs, the test should reproduce the reported failure first.

A good bug-fix loop is:

1. write the failing regression test
2. prove it fails before the fix
3. implement the minimal fix
4. prove the regression test passes
5. run nearby verification

If you cannot reproduce the bug in a test, document the reason and use the strongest available manual verification instead.

## Red Flags

Stop and reset if you notice:

- code written before the test
- test added after implementation
- test passes immediately and you keep going anyway
- one test trying to prove several behaviors
- mocks replacing the very logic under test
- expanding scope during the green step

## Repo-Specific Notes

- Use `pnpm test -- ...`, not raw `pnpm vitest run ...`, unless there is a specific reason.
- Keep tests colocated with source files when that is the existing local pattern.
- Prefer the smallest command that proves the point, then broaden only as needed.
- For bug-fix work, the final explanation should make the fail-before/pass-after story explicit when feasible.

## Completion Standard

Before calling the work done, be able to say:

- which test failed first
- why it failed
- what minimal change made it pass
- what broader verification was run afterward

If you cannot answer those four points, tighten the loop and rerun it.

## Related Skills

- `skills/superpowers-debugging-systematic-debugging/SKILL.md`
- `skills/superpowers-collaboration-writing-plans/SKILL.md`
