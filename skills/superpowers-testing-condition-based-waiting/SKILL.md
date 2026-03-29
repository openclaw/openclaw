---
name: superpowers-testing-condition-based-waiting
description: Replace arbitrary sleeps and guessed timing with waiting for the real condition under test. Use when async tests are flaky, timing-sensitive, or rely on fixed delays.
---

# Condition-Based Waiting

Do not guess how long the system needs. Wait for the state that proves it is ready.

This skill reduces flaky tests caused by arbitrary delays such as `setTimeout`, `sleep`, and fixed waits that pass on fast machines and fail under load or in CI.

## When To Use

Use this skill when tests:

- wait with hard-coded delays
- fail intermittently
- depend on async processing, event delivery, retries, or file creation
- become unreliable under parallel or slower execution

Do not replace a timeout if the timing itself is the behavior under test. In that case, document why the timing matters.

## Core Pattern

Bad:

```ts
await new Promise(resolve => setTimeout(resolve, 100));
expect(queue.size).toBe(1);
```

Better:

```ts
await waitFor(() => queue.size === 1, 'queue to contain one item');
expect(queue.size).toBe(1);
```

## Requirements For Good Waiting Helpers

A good waiting helper:

- polls a fresh condition each iteration
- has a real timeout
- emits a useful timeout message
- uses a sane polling interval

If the condition can yield a value, return that value so the caller does not need to recompute it.

## Polling Guidance

- Prefer short polling intervals that are not wasteful, for example 10-50ms depending on context.
- Always include a timeout with a message that identifies the expected condition.
- Avoid stale snapshots captured outside the polling loop.

## Repo-Specific Advice

In this repo, use condition-based waiting to stabilize async behavior in Vitest tests around:

- event emission
- queue processing
- gateway or channel state transitions
- file system effects
- spawned background work

If you find repeated waiting patterns in one area, extract a small test helper instead of copying ad hoc loops across files.

## When A Fixed Delay Is Still Valid

A fixed delay can be acceptable only when the delay itself is part of the contract being tested, such as debounce windows or retry intervals.

If you keep a fixed delay:

1. state why timing matters
2. tie the delay to a known contract, not a guess
3. still wait for prerequisite conditions first when possible

## Red Flags

- `await sleep(100)` with no explanation
- comments like "give it time"
- tests that only fail on CI
- timeouts copied between files without understanding

## Related Skills

- `skills/superpowers-testing-test-driven-development/SKILL.md`
- `skills/superpowers-testing-testing-anti-patterns/SKILL.md`
