# Code Review: Fix Usage Stats Channel Swap

## Summary

The fix is a single-line change in `src/gateway/server-methods/usage.ts:610` that swaps the nullish coalescing operand order from `storeEntry.channel ?? origin.provider` to `origin.provider ?? storeEntry.channel`. This directly addresses the root cause identified in the spec. Tests are well-structured and cover the key scenarios.

## Findings

### 1. [info] `chatType` resolution has the same precedence issue

At `src/gateway/server-methods/usage.ts:611`, the `chatType` resolution still reads:

```typescript
const chatType = merged.storeEntry?.chatType ?? merged.storeEntry?.origin?.chatType;
```

This mirrors the old (buggy) pattern — preferring the top-level field over `origin`. If `chatType` can diverge from `origin.chatType` in the same way `channel` diverges from `origin.provider`, this line has the same class of bug. Worth investigating whether this matters for any aggregation or display logic.

### 2. [info] Spec acceptance criterion #7 (CSV export) not covered by tests

The spec lists "CSV export includes the correct channel value per session" as an acceptance criterion. No test in this diff exercises the CSV export path. The fix likely covers it implicitly (same `channel` value flows through), but there's no explicit verification.

### 3. [info] Test helper `buildSessionUsage` sets `output: 0` for all cases

The helper always creates input-only usage. This is fine for channel attribution testing, but a single test case with nonzero `output`/`cacheRead` would increase confidence that the aggregation pipeline handles all cost fields correctly under the new resolution order. Minor — not blocking.

## Verdict

The core fix is correct and minimal. The test coverage for channel attribution is thorough — parameterized cases cover DM, group, cross-channel, and legacy fallback scenarios. The swapped-delivery test directly reproduces the reported bug. No critical or normal issues found.
