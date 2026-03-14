# Phase 2: SSRF Pipeline Integration - Context

**Gathered:** 2026-03-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Wire `isDomainBlocked()` from Phase 1's `domain-filter.ts` into `resolvePinnedHostnameWithPolicy()` so that outbound HTTP requests to blocked domains are rejected before DNS resolution. Add integration tests proving end-to-end blocking through the SSRF pipeline.

</domain>

<decisions>
## Implementation Decisions

### Policy Precedence

- Blocklist is a security floor — always enforced, never bypassable by allowlist entries
- Same error message regardless of whether the domain is also in an allowlist ("Domain blocked by DNS blocklist: {domain}")
- No policy-level opt-out (e.g., skipDnsBlocklist) in v1 — deferred to v2 per POL-01/POL-02
- Check applies to both `resolvePinnedHostnameWithPolicy()` and `resolvePinnedHostname()` (the latter delegates to the former, so it's automatic)

### Insertion Ordering

- Blocklist check goes first in `resolvePinnedHostnameWithPolicy()`, immediately after hostname normalization and the null check (after line 283)
- Fires before hostnameAllowlist check, before private-network checks, before DNS lookup
- Uses the already-normalized hostname from line 280, passes normalized value to `DnsBlocklistError`
- Only in the new insertion point — do not modify `isBlockedHostnameOrIp()` or `assertAllowedHostOrIpOrThrow()` (clean separation of concerns)
- Static import of `isDomainBlocked` and `DnsBlocklistError` from `./domain-filter.js` at top of ssrf.ts

### Integration Test Approach

- Tests live in `ssrf.pinning.test.ts` as a new describe block (co-located with existing resolvePinnedHostnameWithPolicy tests)
- Mock DNS lookup to prove blocklist fires pre-DNS: call with blocked .test domain and mock lookupFn, assert DnsBlocklistError thrown and mock never called
- Include regression test: non-blocked domain passes through to DNS lookup successfully
- Verify DnsBlocklistError instanceof SsrFBlockedError (proves existing error handling paths catch blocklist errors)

### Claude's Discretion

- Test case organization within the new describe block
- Whether to add afterEach cleanup for blocklist state in integration tests
- Exact number of integration test cases beyond the required three (blocked, non-blocked regression, instanceof)

</decisions>

<specifics>
## Specific Ideas

- Follow the mock lookup pattern from `ssrf.pinning.test.ts` — it already has mock DNS lookups for testing resolvePinnedHostnameWithPolicy
- The check pattern is: `if (isDomainBlocked(normalized)) { throw new DnsBlocklistError(normalized); }` — two lines of production code
- Test should assert `expect(lookup).not.toHaveBeenCalled()` to prove pre-DNS rejection

</specifics>

<code_context>

## Existing Code Insights

### Reusable Assets

- `isDomainBlocked()` from `src/infra/net/domain-filter.ts`: Phase 1 output, ready to import
- `DnsBlocklistError` from `src/infra/net/domain-filter.ts`: extends SsrFBlockedError, ready to import
- `DEFAULT_BLOCKED_DOMAINS` from `src/infra/net/domain-filter.ts`: test domains (.test, .bad) for test cases

### Established Patterns

- `ssrf.pinning.test.ts`: existing mock DNS lookup tests for resolvePinnedHostnameWithPolicy — follow this pattern
- Static imports in ssrf.ts: all sibling imports use `.js` extension (ESM)
- Error throwing: `assertAllowedHostOrIpOrThrow` pattern — similar guard check

### Integration Points

- `src/infra/net/ssrf.ts` line 283: insertion point after `if (!normalized) throw` and before allowlist check
- `src/infra/net/ssrf.pinning.test.ts`: add new describe block for DNS blocklist integration

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

_Phase: 02-ssrf-pipeline-integration_
_Context gathered: 2026-03-08_
