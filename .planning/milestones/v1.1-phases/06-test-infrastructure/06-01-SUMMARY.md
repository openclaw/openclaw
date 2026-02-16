---
phase: 06-test-infrastructure
plan: 01
subsystem: testing
tags: [vitest, live-tests, test-helpers, error-classification, retry-logic]

# Dependency graph
requires: []
provides:
  - "Shared live test helper module (describeLive, classifyLiveError, withLiveRetry)"
  - "Consistent skip messaging across all 10 live test files"
affects: [06-02-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "describeLive() wrapper for suite-level skip with yellow ANSI message"
    - "classifyLiveError() for 5-category error classification (auth/rate-limit/unavailable/network/logic)"
    - "withLiveRetry() for exponential backoff on rate-limit errors"

key-files:
  created:
    - src/test-utils/live-test-helpers.ts
    - src/test-utils/live-test-helpers.test.ts
  modified:
    - src/agents/minimax.live.test.ts
    - src/agents/zai.live.test.ts
    - src/agents/google-gemini-switch.live.test.ts
    - src/agents/anthropic.setup-token.live.test.ts
    - src/agents/pi-embedded-runner-extraparams.live.test.ts
    - src/agents/models.profiles.live.test.ts
    - src/browser/pw-session.browserless.live.test.ts
    - src/gateway/gateway-cli-backend.live.test.ts
    - src/gateway/gateway-models.profiles.live.test.ts
    - src/media-understanding/providers/deepgram/audio.live.test.ts

key-decisions:
  - "describeLive returns describe or describe.skip (function reference) rather than using custom test runner hooks"
  - "Provider-specific live flags (MINIMAX_LIVE_TEST etc) treated as alternative to global LIVE flag via regex pattern"
  - "Error classification uses string matching on error messages since external API errors lack structured codes"

patterns-established:
  - "Live test files use describeLive() from test-utils/live-test-helpers.ts for consistent skip behavior"
  - "Missing API keys produce yellow [live-skip] console messages naming the key and hint"

# Metrics
duration: 5min
completed: 2026-02-16
---

# Phase 6 Plan 1: Live Test Helpers Summary

**Shared live test helper module with describeLive/classifyLiveError/withLiveRetry utilities, all 10 live test files migrated to consistent skip messaging**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-16T01:55:24Z
- **Completed:** 2026-02-16T02:00:45Z
- **Tasks:** 2
- **Files modified:** 12

## Accomplishments

- Created `src/test-utils/live-test-helpers.ts` with three core exports: `describeLive`, `classifyLiveError`, `withLiveRetry`
- 26 unit tests covering all error classification categories, retry behavior, and skip logic
- Migrated all 10 live test files to use shared `describeLive` helper
- Missing API keys now produce clear yellow skip messages: `[live-skip] minimax live: missing MINIMAX_API_KEY`

## Task Commits

Each task was committed atomically:

1. **Task 1: Create live test helper module** - `f1294d3a1` (feat)
2. **Task 2: Refactor 10 live test files** - `7a3463903` (refactor)

## Files Created/Modified

- `src/test-utils/live-test-helpers.ts` - Shared describeLive, classifyLiveError, withLiveRetry utilities
- `src/test-utils/live-test-helpers.test.ts` - 26 unit tests for helper module
- `src/agents/minimax.live.test.ts` - Migrated to shared describeLive
- `src/agents/zai.live.test.ts` - Migrated to shared describeLive
- `src/agents/google-gemini-switch.live.test.ts` - Migrated to shared describeLive
- `src/agents/anthropic.setup-token.live.test.ts` - Migrated to shared describeLive
- `src/agents/pi-embedded-runner-extraparams.live.test.ts` - Migrated to shared describeLive
- `src/agents/models.profiles.live.test.ts` - Migrated to shared describeLive
- `src/browser/pw-session.browserless.live.test.ts` - Migrated to shared describeLive
- `src/gateway/gateway-cli-backend.live.test.ts` - Migrated to shared describeLive
- `src/gateway/gateway-models.profiles.live.test.ts` - Migrated to shared describeLive
- `src/media-understanding/providers/deepgram/audio.live.test.ts` - Migrated to shared describeLive

## Decisions Made

- Used function-reference return pattern (`describeLive` returns `describe` or `describe.skip`) rather than custom test runner hooks -- simpler, no framework coupling
- Provider-specific live flags (e.g. `MINIMAX_LIVE_TEST`) recognized via `/_LIVE(?:_TEST)?$/` regex as alternative to global `LIVE` or `OPENCLAW_LIVE_TEST`
- Error classification uses string pattern matching since external API errors are unstructured strings

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Helper module ready for 06-02 (custom Vitest reporter) to consume `classifyLiveError` and `describeLive` patterns
- All live test files consistently use shared helpers

## Self-Check: PASSED

All 12 files verified present. Both task commits (f1294d3a1, 7a3463903) verified in git log.

---

_Phase: 06-test-infrastructure_
_Completed: 2026-02-16_
