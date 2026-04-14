# Test Debt Registry

## Summary

- Total test files: 1537
- Passing: ~1472
- Failing: ~65 (down from 721 after ontology pack sync)
- Root cause: Test isolation issues in parallel execution, not production logic failures

## Resolved

- **721 failures** caused by stale `src/ontology-packs/` missing Phase A scoring fields. Fixed by syncing from root `ontology-packs/`.

## Remaining Failures (Non-Blocking)

Approximately 65 test files fail when run in the full suite but pass individually. This indicates shared state or test isolation issues in Vitest's parallel execution, not production code defects.

### Categories

- **Test isolation**: Most failures. Tests pass in isolation, fail in parallel. Likely shared global state (pack registry, config singletons).
- **bash-tools assertion**: One genuine test expectation mismatch in `src/agents/bash-tools.test.ts` — not ClarityBurst-related.
- **No ClarityBurst production blockers identified.**

### Affected Modules (not ClarityBurst)

- browser/server, canvas-host, telegram, cron, web, auto-reply, memory, docker, config/sessions, media

## Action Items

- [ ] Investigate Vitest parallel isolation (pool: "forks" may need per-file isolation for pack registry)
- [ ] Fix bash-tools assertion mismatch
- [ ] Consider `--no-threads` or `--pool=threads` for CI stability
