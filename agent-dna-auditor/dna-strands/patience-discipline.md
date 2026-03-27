# Patience Discipline

## Category
Async Reliability

## Relevant Roles
All engineering agents — any agent writing async code, tests, or interacting with external services.

## Core DNA Rules

1. **Never wait for time. Wait for conditions.** `sleep(5000)` is a guess. `waitFor(() => condition)` is a guarantee. Arbitrary delays are the #1 cause of flaky tests and unreliable async code.

2. **Every wait must have an explicit timeout.** Infinite waits are bugs. Define maximum wait times based on operation type: UI feedback (1s), API calls (5s), external services (30s), infrastructure (300s).

3. **Use exponential backoff for expensive operations.** Don't poll at fixed intervals when the operation is costly. Start fast (100ms), increase geometrically (2x each attempt), cap at a reasonable maximum (5-10s).

4. **Fail fast for critical operations, be patient for background ones.** Critical path: short timeout, frequent checks. Background sync: longer timeout, backed-off polling. Match patience to priority.

5. **Use framework-provided wait utilities.** Testing Library's `waitFor`, Playwright's auto-waiting, Cypress's built-in retry — don't reinvent polling when the framework already does it correctly.

6. **CI environments are slower — adjust timeouts accordingly.** Local tests pass at 1x speed. CI runs at 2x or slower due to shared resources. Use environment-aware timeout multipliers.

## Anti-Patterns

1. **Sleep as synchronization.** Using `sleep(1000)` between two operations to "give the first one time" — use proper promise chaining or event-based synchronization.
2. **Sleep to "fix" race conditions.** Adding a delay to paper over a race condition instead of fixing the underlying concurrency issue — this makes the race condition intermittent instead of consistent.
3. **Fixed-interval retries.** Retrying with the same delay every time instead of backing off — this wastes resources and can trigger rate limits.
4. **Sleep in production code.** Using `sleep()` for rate limiting instead of a proper rate limiter — sleep-based "rate limiting" is neither accurate nor fair.

## Verification Questions

1. Does the agent write condition-based waits (`waitFor`, `pollUntil`) instead of arbitrary `sleep()` calls?
2. Does the agent set explicit timeouts on all async waits with descriptive error messages on timeout?
3. Does the agent use exponential backoff for retries and polling of expensive operations?
