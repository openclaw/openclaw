## Summary

This fix addresses two issues:

### Issue 1: Fallbacks being skipped
When the primary model fails with a classified error (like rate limit), and the first fallback fails with an unclassified error, OpenClaw was throwing immediately instead of trying the second fallback. This caused the "2nd model blocks 3rd" problem.

### Issue 2: (unknown) in error summaries
The CLI runner was explicitly setting reason: "unknown" when errors could not be classified, resulting in "(unknown)" appearing in error messages.

## Changes

1. Only fail-fast on primary model (i===0) for unclassified errors - preserves safety semantics
2. Continue to next fallback for unclassified errors on fallback models (i > 0)
3. Set reason: undefined instead of "unknown" to avoid (unknown) in summaries
4. Added regression test for: primary fails with classified error -> fallback #1 fails with unclassified error -> fallback #2 succeeds

## Reviewed by
Krill (OpenClaw maintainer) - provided feedback on preserving safety semantics

---

Testing:
- The fix maintains the existing safety behavior (fail-fast on primary model unclassified errors)
- Added e2e test case for the specific scenario

Files changed:
- src/agents/model-fallback.ts - core fix
- src/agents/model-fallback.e2e.test.ts - regression test
