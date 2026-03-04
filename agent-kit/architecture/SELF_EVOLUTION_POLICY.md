# Self Evolution Policy

This policy is the safety envelope for autonomous improvement.

## Hard constraints

- No direct commits to the active production branch.
- Every self-change must run through branch isolation and quality gates.
- If any gate fails, the change is rejected automatically.
- Security and auth settings are never modified automatically.

## Required gates

1. Formatting check
2. Typecheck
3. Build smoke
4. Fast unit tests
5. Channel tests
6. Config validation for the monster profile

## Promotion rule

A change is promotable only when all gates pass and the diff is human-reviewed.

## Rollback rule

If post-merge regression appears:

1. revert the merge commit
2. restore last known-good config
3. rerun gate suite

## Improvement signal loop

- collect failures from test artifacts and runtime logs
- prioritize recurring classes of failure
- generate one targeted fix per cycle
- stop when no measurable gain appears in two consecutive cycles
