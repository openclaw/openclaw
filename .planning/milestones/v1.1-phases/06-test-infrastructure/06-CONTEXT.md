# Phase 6: Test Infrastructure - Context

**Gathered:** 2026-02-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Clear diagnostics, graceful skips, and isolated test execution for live tests. Developer gets clear, actionable feedback from live test runs regardless of environment configuration. Does not add new tests — that's Phases 7 and 8.

</domain>

<decisions>
## Implementation Decisions

### Skip messaging

- Skip message includes key name + hint: e.g. `Skipped: ANTHROPIC_API_KEY not set — export it or add to .env`
- Skips are visually prominent (yellow) in output — developer always knows what's missing
- End-of-run summary block lists all missing keys, deduplicated
- Summary maps keys to the test files they would enable: e.g. `ANTHROPIC_API_KEY — would enable: agent-anthropic.live.test.ts, ...`

### Runner output format

- One line per individual test case (not per file)
- Three statuses with distinct visual treatment: pass, fail, skip (plus "unavailable" — see error classification)

### Test isolation

- Shared helpers are OK (e.g. `requireApiKey`, `createTestAgent`) — no ordering dependencies between files
- Each file must be runnable independently via `bun run test:live <file>`
- Tests must always clean up external state they create (sessions, messages, etc.)
- 30-second timeout per test (moderate — most API calls finish in under 10s)

### Error classification

- Missing API key → skip with named key + hint
- Invalid/expired API key (auth error) → skip (bad setup, not a code bug)
- Rate limit → retry 2-3 times with exponential backoff before failing
- Network/logic error → fail (real failure)
- External service unavailable (e.g. Browserless down) → distinct "unavailable" status, separate from pass/fail/skip
- Failed test output: error type + message only (no request details or stack traces)

### Claude's Discretion

- End-of-run summary format (counts, failed test listing, etc.)
- Timing display (per-test, total, or both)
- Passing test output suppression vs showing
- Single-file execution setup approach (global check vs self-contained)

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

_Phase: 06-test-infrastructure_
_Context gathered: 2026-02-16_
