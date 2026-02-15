---
phase: 04-output-controls-execution-tracing
plan: 01
subsystem: security
tags: [csp, output-filtering, content-policy, redaction]

# Dependency graph
requires:
  - phase: 01-foundation-repo-hygiene
    provides: security event infrastructure (emitSecurityEvent, SecurityEvent type)
provides:
  - Output CSP rule engine with 6 detect+redact rules
  - Per-channel output policy configuration (SecurityConfig.outputPolicy)
  - CSP integration in normalizeReplyPayload (pre-chunking)
  - output.csp.stripped and trace.tool.call security event types
affects: [04-02-execution-tracing, reply-dispatcher-wiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [detect-redact rule pattern, fail-open-fail-loud output filtering]

key-files:
  created:
    - src/security/output-policy.ts
    - src/security/output-policy.test.ts
  modified:
    - src/security/events.ts
    - src/config/types.security.ts
    - src/auto-reply/reply/normalize-reply.ts

key-decisions:
  - "Regex-based rule definitions with detect+redact pattern for composability"
  - "CSP placed after sanitizeUserFacingText, before LINE directives and chunking"
  - "Fail-open delivery (redacted text sent) with fail-loud logging (security events)"

patterns-established:
  - "Output CSP rule pattern: each rule has id, detect(text) -> matches, redact(text) -> cleaned"
  - "Channel resolution pattern: case-insensitive lookup with default fallback (matches input-screening)"

# Metrics
duration: 3min
completed: 2026-02-16
---

# Phase 4 Plan 1: Output CSP Summary

**Per-channel output Content Security Policy with 6 rule types filtering reply text before delivery, emitting security events on redaction**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-15T23:53:01Z
- **Completed:** 2026-02-15T23:55:44Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Output CSP module with 6 detect+redact rules: no-external-urls, no-file-paths, no-code-blocks, no-system-info, no-api-keys, no-internal-ips
- Per-channel output policy resolution with default fallback (mirrors input-screening pattern)
- CSP filter integrated into normalizeReplyPayload before chunking/LINE directives
- 24 tests covering all rules, multi-rule application, and channel resolution

## Task Commits

Each task was committed atomically:

1. **Task 1: Create output CSP module with rule definitions, filter, and config types** - `6ac7ed355` (feat)
2. **Task 2: Integrate CSP filter into normalizeReplyPayload and emit security events** - `0fdb7a662` (feat)

## Files Created/Modified
- `src/security/output-policy.ts` - CSP rule definitions, applyOutputCsp filter, resolveChannelOutputRules
- `src/security/output-policy.test.ts` - 24 tests for all rules and resolution logic
- `src/security/events.ts` - Added output.csp.stripped and trace.tool.call event types
- `src/config/types.security.ts` - Extended SecurityConfig with outputPolicy section
- `src/auto-reply/reply/normalize-reply.ts` - CSP filtering in normalizeReplyPayload with security event emission

## Decisions Made
- Regex-based rule definitions with detect+redact pattern for composability
- CSP placed after sanitizeUserFacingText, before LINE directives and chunking — ensures all sanitization happens before structural parsing
- Fail-open delivery (redacted text still sent) with fail-loud logging (security events emitted for each rule match)
- trace.tool.call event type added in this plan to avoid file conflicts with 04-02

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Output CSP module ready for wiring into reply-dispatcher (caller opt-in via optional NormalizeReplyOptions fields)
- trace.tool.call event type pre-registered for Plan 04-02 execution tracing
- SecurityConfig.outputPolicy type ready for config loading integration

---
*Phase: 04-output-controls-execution-tracing*
*Completed: 2026-02-16*
