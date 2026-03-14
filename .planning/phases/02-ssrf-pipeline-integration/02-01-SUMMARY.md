---
phase: 02-ssrf-pipeline-integration
plan: 01
subsystem: infra
tags: [ssrf, dns-blocklist, security, domain-filter]

# Dependency graph
requires:
  - phase: 01-domain-blocklist-module
    provides: isDomainBlocked function and DnsBlocklistError class
provides:
  - Blocklist guard wired into resolvePinnedHostnameWithPolicy (pre-DNS security floor)
  - Integration tests proving end-to-end blocking through SSRF pipeline
affects: [03-outbound-surface-catalog]

# Tech tracking
tech-stack:
  added: []
  patterns: [ssrf-error extraction to break circular deps]

key-files:
  created:
    - src/infra/net/ssrf-error.ts
  modified:
    - src/infra/net/ssrf.ts
    - src/infra/net/ssrf.pinning.test.ts
    - src/infra/net/domain-filter.ts

key-decisions:
  - "Extracted SsrFBlockedError into ssrf-error.ts to break circular dependency between ssrf.ts and domain-filter.ts"
  - "Blocklist check uses normalized hostname (not raw parameter) for consistency with existing guards"

patterns-established:
  - "ssrf-error.ts as shared error leaf module: both ssrf.ts and domain-filter.ts import from it"

requirements-completed: [SSRF-01, TEST-02]

# Metrics
duration: 4min
completed: 2026-03-08
---

# Phase 2 Plan 1: SSRF Pipeline Integration Summary

**DNS blocklist guard wired into resolvePinnedHostnameWithPolicy as pre-DNS security floor with 4 integration tests**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-08T16:04:19Z
- **Completed:** 2026-03-08T16:08:59Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Blocklist check fires before all other guards (allowlist, private-network, DNS) in resolvePinnedHostnameWithPolicy
- 4 integration tests prove: blocked domain pre-DNS rejection, non-blocked regression, SsrFBlockedError instanceof hierarchy, subdomain blocking
- Circular dependency between ssrf.ts and domain-filter.ts resolved by extracting SsrFBlockedError into ssrf-error.ts
- Full test suite (859 files, 7001 tests) passes green

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire blocklist guard into resolvePinnedHostnameWithPolicy** - `2770dbbad` (feat)
2. **Task 2: Add DNS blocklist integration tests** - `a1a1bd5a1` (test)

**Auto-fix commit:** `4f864c540` (fix: break circular dependency)

## Files Created/Modified

- `src/infra/net/ssrf-error.ts` - Extracted SsrFBlockedError base class (breaks circular dep)
- `src/infra/net/ssrf.ts` - Added isDomainBlocked import, blocklist guard at line 284, re-exports SsrFBlockedError
- `src/infra/net/ssrf.pinning.test.ts` - New "DNS blocklist integration" describe block with 4 tests
- `src/infra/net/domain-filter.ts` - Updated import to use ssrf-error.ts instead of ssrf.ts

## Decisions Made

- Extracted SsrFBlockedError into ssrf-error.ts to break the circular dependency created by ssrf.ts importing from domain-filter.ts (which imports SsrFBlockedError from ssrf.ts). Re-export preserves all existing import paths.
- Blocklist guard uses the already-normalized hostname (line 280) rather than raw parameter, consistent with the plan's design decision.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Circular dependency between ssrf.ts and domain-filter.ts**

- **Found during:** Task 2 (integration tests) -- full test suite revealed 166 test files failing
- **Issue:** Adding `import { isDomainBlocked } from "./domain-filter.js"` to ssrf.ts created a cycle: ssrf.ts -> domain-filter.ts -> ssrf.ts. At runtime, SsrFBlockedError was undefined when domain-filter.ts tried to extend it.
- **Fix:** Extracted SsrFBlockedError into src/infra/net/ssrf-error.ts. ssrf.ts re-exports it so all existing consumers are unaffected. domain-filter.ts now imports from ssrf-error.ts.
- **Files modified:** src/infra/net/ssrf-error.ts (created), src/infra/net/ssrf.ts, src/infra/net/domain-filter.ts
- **Verification:** Full test suite (859 files, 7001 tests) passes. Build passes with no type errors.
- **Committed in:** 4f864c540

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Essential fix for correctness. The circular dependency was an unavoidable consequence of the planned import wiring. No scope creep.

## Issues Encountered

None beyond the circular dependency (documented above as deviation).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- SSRF pipeline now enforces DNS blocklist as security floor
- Phase 3 can catalog all outbound HTTP surfaces and verify chokepoint coverage
- No blockers or concerns

---

_Phase: 02-ssrf-pipeline-integration_
_Completed: 2026-03-08_
