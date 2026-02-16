# Phase 7: Agent & Gateway Live Tests - Context

**Gathered:** 2026-02-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Make every agent provider integration (Anthropic, Gemini, MiniMax, Zai) and gateway CLI/profile live test pass against real services. This phase fixes existing failing tests — it does not add new test coverage or new provider integrations.

</domain>

<decisions>
## Implementation Decisions

### Failure strategy
- Assume failures are our bug until proven otherwise — fix our code first
- If a test fails due to a genuine provider-side issue (API changed, rate limited, service down), skip with a clear message using the describeLive skip mechanism
- Do not let provider-side issues block the rest of the suite

### Provider tiers
- Core providers (Anthropic, Gemini) must pass — no excuses
- Secondary providers (MiniMax, Zai) get softer treatment: longer timeouts, more retries, tolerance for provider instability
- All providers should still be tested; tiering is about tolerance, not exclusion

### Gateway test lifecycle
- Gateway tests auto-spawn a gateway instance in beforeAll, tear down in afterAll — fully self-contained
- Use a fixed test port (e.g., 13337) reserved for testing
- If the gateway fails to start, that's a real bug to fix — don't skip or work around it

### Claude's Discretion
- Whether code changes beyond minimal fixes are worthwhile (cleanup scope per case)
- CLI test approach: subprocess vs programmatic — pick based on what existing tests do
- Specific timeout/retry values per provider

</decisions>

<specifics>
## Specific Ideas

- Phase 6 built `describeLive` helper and LiveTestReporter — use these throughout
- Provider-specific live flags (regex-based) are already supported from Phase 6 work
- Existing tests already exist — this is about making them pass, not writing new ones

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 07-agent-gateway-live-tests*
*Context gathered: 2026-02-16*
