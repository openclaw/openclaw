---
name: superpowers-testing-testing-anti-patterns
description: Avoid misleading tests that mainly verify mocks, incomplete doubles, or test-only production code. Use when writing or revising tests, especially when mocking becomes heavy or suspicious.
---

# Testing Anti-Patterns

Tests should prove real behavior. If they mostly prove that the test harness is wired a certain way, they are giving false confidence.

This skill is a guardrail against common test mistakes that look efficient but quietly detach the test from the actual system behavior.

## Anti-Pattern 1: Testing The Mock

If the assertion mainly proves a mock rendered, was called, or exists, you are probably testing the mock instead of the product code.

Ask:

- would this test still mean anything if the mock internals changed?
- does the assertion describe user-visible or contract-visible behavior?

If not, rewrite the test around real behavior or reduce the mocking.

## Anti-Pattern 2: Test-Only Production APIs

Do not add methods or branches to production code solely to make tests convenient.

If cleanup or control hooks are needed only for tests, move them into:

- test utilities
- dependency injection seams
- factory helpers

Production APIs should exist because production needs them.

## Anti-Pattern 3: Mocking Without Understanding Dependencies

Before mocking a dependency, understand what the real dependency contributes:

- data shape
- side effects
- lifecycle
- state transitions

Mocking a high-level method that performs essential side effects often breaks the very behavior the test is supposed to cover.

Mock at the lowest useful boundary.

## Anti-Pattern 4: Incomplete Mocks

If you mock a response or object, mirror the real structure closely enough that downstream code sees what production would provide.

Partial mocks are dangerous because they hide structural assumptions until integration time.

When unsure, inspect the real type, fixture, or documented shape first.

## Anti-Pattern 5: Tests As Afterthought

If implementation is "done" and tests come later, you have already lost the most valuable part of the feedback loop.

Use the TDD skill to prevent this drift.

## When To Prefer Real Components

Prefer real collaborators or thin fakes when:

- mock setup is larger than the actual assertion
- the test depends on several coupled side effects
- the mock has to reimplement too much behavior
- the failure mode only appears with the real integration

Integration tests are often simpler and more honest than elaborate mocks.

## Quick Self-Check

Before keeping a test, ask:

1. What behavior does this test prove?
2. Which part is real, and which part is doubled?
3. Would the same bug still be caught if mock internals changed?
4. Did I add anything to production only for this test?

If the answers are weak, rewrite the test.

## Repo-Specific Notes

In this repo:

- prefer colocated tests that exercise the real module path when practical
- avoid prototype mutation unless a test explicitly documents why it is required
- be cautious about mocking helpers that also persist config, alter routing, or manage state transitions

## Related Skills

- `skills/superpowers-testing-test-driven-development/SKILL.md`
- `skills/superpowers-testing-condition-based-waiting/SKILL.md`
