# Phase 1: Domain Blocklist Module - Context

**Gathered:** 2026-03-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Standalone `isDomainBlocked()` function with suffix-based domain matching against an atomic `Set<string>`, plus comprehensive unit tests. This module lives in `src/infra/net/domain-filter.ts` as a sibling to `ssrf.ts`. No SSRF integration wiring in this phase — that's Phase 2.

</domain>

<decisions>
## Implementation Decisions

### Starter List Content
- Test-only domains using safe TLDs that can never conflict with real domains (.test, .bad)
- 5-8 domains: malware.test, phishing.test, tracker.test, adware.test, etc.
- Export the list as `DEFAULT_BLOCKED_DOMAINS` so tests can reference it
- Module-level `Set<string>` constant with a `setBlockedDomains()` swap function for future config/remote list updates

### Error Messaging
- Include the actual blocked domain name in the error message
- Descriptive tone: "Domain blocked by DNS blocklist: malware.test"
- New `DnsBlocklistError` subclass extending `SsrFBlockedError` — callers can distinguish blocklist from SSRF errors

### Module API Surface
- `isDomainBlocked(hostname: string): boolean` — core check, hostname only (caller extracts from URL)
- `setBlockedDomains(domains: string[]): void` — atomic replace of the entire Set
- `addBlockedDomain(domain: string): void` — add single domain
- `removeBlockedDomain(domain: string): void` — remove single domain
- `DnsBlocklistError` class — exported error subclass
- `DEFAULT_BLOCKED_DOMAINS` — exported starter list constant

### File Placement
- File: `src/infra/net/domain-filter.ts`
- Test: `src/infra/net/domain-filter.test.ts`
- Sibling to `ssrf.ts` and `hostname.ts` — same directory as the code it integrates with

### Claude's Discretion
- Exact suffix-walking implementation details
- Test case organization and edge case selection
- Whether to normalize domains in setBlockedDomains/add/remove or require pre-normalized input

</decisions>

<specifics>
## Specific Ideas

- Follow the same test fixture pattern as `ssrf.test.ts` (arrays of cases with clear variable names like `privateIpCases`, `publicIpCases`)
- The `normalizeHostname()` function from `hostname.ts` handles trimming, lowercase, trailing dot removal, and bracket stripping — reuse it for domain normalization
- `BLOCKED_HOSTNAMES` in `ssrf.ts` is a `Set<string>` — match that pattern for the blocklist Set

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `normalizeHostname()` from `src/infra/net/hostname.ts`: handles trim, lowercase, trailing dot removal, bracket stripping
- `SsrFBlockedError` from `src/infra/net/ssrf.ts`: base error class to extend for `DnsBlocklistError`
- `BLOCKED_HOSTNAMES` pattern in `ssrf.ts`: existing `Set<string>` for hostname blocking — model after this

### Established Patterns
- Error classes: extend `Error`, set `this.name`, use constructor with message string (see `SsrFBlockedError`, `ArchiveSecurityError` patterns)
- Module constants: `UPPER_SNAKE_CASE` for exported constants
- Test organization: arrays of test cases, `describe`/`it` blocks, co-located `.test.ts` files
- Named exports preferred over default exports
- `.js` extensions in all import paths (ESM)

### Integration Points
- `src/infra/net/ssrf.ts` `resolvePinnedHostnameWithPolicy()` — Phase 2 will import `isDomainBlocked` here
- `src/infra/net/hostname.ts` `normalizeHostname()` — imported for domain normalization

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-domain-blocklist-module*
*Context gathered: 2026-03-08*
