---
title: "Flaky Test Policy"
summary: "Definition, detection, tracking, and burn-down process for flaky tests in OpenClaw CI"
read_when:
  - A test is flaking in CI and you need to know the process
  - Reviewing flaky test debt in the weekly ops review
  - Adding a new test and want to avoid common flakiness causes
---

# Flaky Test Policy

## Definition

A test is **flaky** when it produces different outcomes (pass/fail) across runs
without code changes — typically due to timing, non-deterministic ordering, shared
global state, missing cleanup, or external service dependence.

Flaky tests are infrastructure debt: they erode confidence in CI, slow down
reviews, and mask real regressions. This policy defines how to identify, track,
and eliminate them.

---

## Detection

### Automatic detection in CI

CI jobs that fail in retry-eligible fashion emit a `[flaky]` label on the job summary.
Use the GitHub Actions "Re-run failed jobs" feature to confirm flakiness:

- If a job passes on the first retry with no code change → flaky candidate
- If a job fails consistently across 3+ runs → likely a real regression

### Manual detection

```bash
# Run the test suite 5 times and collect failures
for i in {1..5}; do pnpm test 2>&1 | tee /tmp/run-$i.txt; done
grep -l "FAIL\|Error" /tmp/run-*.txt
```

---

## Reporting a flaky test

When you identify a flaky test:

1. Open a GitHub issue with label `flaky-test`.
2. Include:
   - Test file and test name
   - Failure mode (what error / assertion fails)
   - Approximate fail rate (e.g., "fails 1 in 5 runs")
   - Link to a recent CI run showing the failure
3. If the test is in a hot test file (runs frequently), mark the issue `priority: high`.

---

## Burn-down process

### Weekly review

During the [weekly ops review](./ops-review.md), review the open `flaky-test` issue list:

- Are any new flaky tests added since last week?
- Have any been fixed and closed?
- Are any flaky tests blocking PRs or releases?

### Triage criteria

| Category | Action |
|---|---|
| Flaky in hot path (unit shard, check-fast) | Fix within 1 sprint; escalate if blocking |
| Flaky in extended suite (nightly/live) | Fix within 2 sprints |
| Flaky in platform-specific CI (macOS/Android) | Fix within 1 month; may accept skip with comment if platform-only |
| Confirmed race condition | Fix before merging any related code change |

### Fixing flaky tests

Common root causes and fixes:

| Root cause | Fix |
|---|---|
| Missing cleanup (timers, mocks, file handles) | Add `afterEach` / `afterAll` cleanup; see testing guidelines in `AGENTS.md` |
| Shared global state | Use `vi.restoreAllMocks()` + reset module state; avoid `beforeEach` with `vi.resetModules()` for heavy modules |
| Timing / race condition | Use `vi.useFakeTimers()` or explicit `await` + polling; avoid `setTimeout` delays in assertions |
| File system order sensitivity | Sort explicitly; do not rely on `readdir` order |
| Network call in unit test | Mock the transport layer; unit tests must not make real network calls |
| Port conflicts in integration tests | Use random ports or test-assigned ports |

### Never do

- **Do not quarantine** (skip/todo) a flaky test without a linked issue and a target fix date.
- **Do not edit expected-failure baselines or snapshots** to silence a flaky test without
  explicit maintainer approval and an explanation.
- **Do not remove** a flaky test without replacing it with equivalent non-flaky coverage.

---

## Policy enforcement

- The `scripts/run-vitest.mjs` runner counts consecutive failures across workers.
  A test that fails 3+ times in a single `pnpm test` run is flagged in the output.
- Flaky tests in `src/gateway` and `src/agents` are high-priority because those
  suites use `forks` pool — each test spawns a new process, so global state leaks
  are more visible there.
- The `pnpm test:coverage` gate enforces V8 thresholds (70 % lines/branches/functions/
  statements). Do not lower thresholds to work around flaky coverage results; fix the tests.

---

## Metrics

Track at the weekly ops review:

- Open `flaky-test` issues count (target: trending to 0)
- New flaky tests added this week
- Flaky tests fixed this week
- CI re-run rate for the main branch (target: < 5 % of runs require a retry)
