# Architecture Patterns

**Domain:** DNS blocklist filtering for AI agent gateway outbound HTTP
**Researched:** 2026-03-08

## Recommended Architecture

Extend the existing two-phase SSRF guard with a domain blocklist check inserted at the start of Phase 1 (pre-DNS). No new module boundary -- the blocklist is a new layer inside `src/infra/net/ssrf.ts` backed by a dedicated blocklist data structure in a sibling file.

### High-Level Flow

```
Outbound URL request
       |
       v
  [URL parse: extract hostname]
       |
       v
  [normalizeHostname()]
       |
       v
  [DNS Blocklist check]  <-- NEW: isDomainBlocked(hostname)
       |  blocked? --> throw SsrFBlockedError("Blocked: domain is on DNS blocklist")
       |
       v
  [Existing Phase 1: literal hostname/IP checks]
       |  blocked hostname/private IP? --> throw SsrFBlockedError
       |
       v
  [DNS resolution]
       |
       v
  [Existing Phase 2: resolved address checks]
       |  resolves to private/internal IP? --> throw SsrFBlockedError
       |
       v
  [Pin DNS + dispatch request]
```

The blocklist check goes **before** existing Phase 1 because:
1. It is the cheapest check (Set lookup, no DNS, no IP parsing).
2. Known-malicious domains should be rejected before any DNS side-effects.
3. It shares the same `normalizeHostname()` output that Phase 1 already computes.

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `src/infra/net/dns-blocklist.ts` (NEW) | Owns blocklist data structure, `isDomainBlocked()` function, domain matching logic (exact + subdomain) | Consumed by `ssrf.ts` |
| `src/infra/net/ssrf.ts` (EXTENDED) | Orchestrates all pre-flight hostname/IP checks; calls `isDomainBlocked()` in `resolvePinnedHostnameWithPolicy()` before Phase 1 | Calls `dns-blocklist.ts`; called by `fetch-guard.ts`, `navigation-guard.ts`, direct callers |
| `src/infra/net/fetch-guard.ts` (UNCHANGED) | SSRF-guarded fetch with redirect following; already calls `resolvePinnedHostnameWithPolicy()` | No changes needed; inherits blocklist protection automatically |
| `src/browser/navigation-guard.ts` (UNCHANGED) | Browser navigation SSRF guard; already calls `resolvePinnedHostnameWithPolicy()` | No changes needed; inherits blocklist protection automatically |
| `src/plugin-sdk/ssrf-policy.ts` (UNCHANGED) | Suffix-based hostname allowlisting for plugins | Orthogonal; allowlists and blocklists are independent concerns |

### Why a Separate File (`dns-blocklist.ts`) Instead of Inline in `ssrf.ts`

- `ssrf.ts` is already 364 lines with dense IP/hostname logic. Adding blocklist parsing, matching, and future config/URL-fetching concerns would push it past maintainability thresholds.
- A separate file isolates the blocklist data structure, making it independently testable.
- Future work (config-driven lists, remote URL fetching, refresh intervals) stays contained.
- The module boundary is clean: `dns-blocklist.ts` exports `isDomainBlocked(hostname: string): boolean` and `setBlocklist(domains: string[]): void`. No circular deps.

## Data Flow

### Request-Time Check (Synchronous Path)

```
caller (web-fetch tool, media store, link detector, etc.)
  --> fetchWithSsrFGuard({ url, policy })
    --> resolvePinnedHostnameWithPolicy(hostname, { policy })
      --> normalizeHostname(hostname)
      --> isDomainBlocked(normalized)        // NEW: O(1) Set lookup
      --> assertAllowedHostOrIpOrThrow()     // existing Phase 1
      --> dnsLookup()                        // existing DNS resolution
      --> assertAllowedResolvedAddressesOrThrow()  // existing Phase 2
    --> createPinnedDispatcher(pinned)
  --> fetch(url, { dispatcher })
```

### Blocklist Initialization (Startup Path)

```
Gateway startup
  --> loadBlocklist()                        // reads hard-coded list initially
  --> setBlocklist(domains)                  // populates internal Set<string>
```

Future milestone adds:
```
Gateway startup / periodic refresh
  --> config.get("security.dnsBlocklists")   // URL(s) to fetch
  --> fetch blocklist files (Hagezi format: one domain per line, # comments)
  --> parse + merge with built-in list
  --> setBlocklist(merged)
```

### Domain Matching Algorithm

```typescript
// Exact match: "malware.example.com" blocks "malware.example.com"
// Subdomain match: "example.com" blocks "foo.example.com", "bar.baz.example.com"
// Does NOT block unrelated: "example.com" does NOT block "notexample.com"

function isDomainBlocked(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;

  // Walk up the domain hierarchy
  let domain = normalized;
  while (domain) {
    if (blockedDomains.has(domain)) return true;
    const dotIndex = domain.indexOf(".");
    if (dotIndex === -1) break;
    domain = domain.slice(dotIndex + 1);
  }
  return false;
}
```

This "walk up the label tree" approach is the standard pattern used by browser safe-browsing, Pi-hole, and AdGuard. It handles subdomain blocking naturally: adding `example.com` to the blocklist blocks all subdomains without needing wildcard syntax. The walk is bounded by label count (max ~127 labels in a valid hostname), so worst case is negligible.

## Patterns to Follow

### Pattern 1: Fail-Closed Error Handling

**What:** Blocked domains throw `SsrFBlockedError` with a descriptive message, identical to existing SSRF blocks.
**When:** Always. Callers already handle `SsrFBlockedError` uniformly.
**Why:** Existing error-handling paths in `fetch-guard.ts` (audit logging at line 244-248), `web-fetch.ts`, and `server-cron.ts` all catch `SsrFBlockedError`. A new error type would require updating every catch site.

```typescript
// In dns-blocklist.ts
export function assertDomainNotBlocked(hostname: string): void {
  if (isDomainBlocked(hostname)) {
    throw new SsrFBlockedError(`Blocked: domain "${hostname}" is on DNS blocklist`);
  }
}
```

### Pattern 2: Normalization Before Comparison

**What:** Always normalize hostnames via `normalizeHostname()` before blocklist lookup.
**When:** At every entry point -- both when populating the blocklist and when checking against it.
**Why:** Prevents bypasses via trailing dots (`evil.com.`), mixed case (`Evil.COM`), or bracket-wrapped IPv6.

### Pattern 3: Single Integration Point

**What:** Insert the blocklist check inside `resolvePinnedHostnameWithPolicy()` rather than at each caller.
**When:** Always. This function is the single chokepoint for all SSRF-guarded outbound requests.
**Why:** There are 16+ files that use SSRF functions. Hooking at the chokepoint means all callers get blocklist protection automatically:
- `fetchWithSsrFGuard()` in `fetch-guard.ts`
- `assertBrowserNavigationAllowed()` in `navigation-guard.ts`
- `resolvePinnedHostname()` (delegates to `resolvePinnedHostnameWithPolicy`)
- `assertPublicHostname()` (delegates to `resolvePinnedHostname`)
- Direct callers in test harnesses, media store, etc.

### Pattern 4: Immutable Blocklist Swap

**What:** Blocklist updates replace the entire `Set<string>` atomically rather than mutating in place.
**When:** On initialization and any future refresh.
**Why:** Avoids race conditions during concurrent request processing. A request mid-check keeps a reference to the old Set; new requests see the new Set. No locking needed.

```typescript
let blockedDomains: ReadonlySet<string> = new Set();

export function setBlocklist(domains: readonly string[]): void {
  blockedDomains = new Set(domains.map(d => normalizeHostname(d)).filter(Boolean));
}
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Parallel Filtering System

**What:** Creating a separate `DnsBlocklistGuard` class with its own fetch wrapper that callers must opt into.
**Why bad:** Fragmented coverage. Some paths would have blocklist protection, others would not. Impossible to audit completeness.
**Instead:** Inject into `resolvePinnedHostnameWithPolicy()` so every SSRF-guarded path inherits it.

### Anti-Pattern 2: Regex-Based Domain Matching

**What:** Using regex patterns to match blocked domains.
**Why bad:** Regex is slower than Set lookup for exact/suffix matching, error-prone (escaping dots), and opens ReDoS risk with user-provided patterns.
**Instead:** Use `Set<string>` with label-walking for subdomain matching.

### Anti-Pattern 3: Blocklist as Part of `SsrFPolicy`

**What:** Adding blocklist entries to the `SsrFPolicy` type so each caller can pass custom blocklists.
**Why bad:** DNS blocklists are a global security concern, not a per-request policy. Making them per-request means callers can accidentally omit them. The existing `BLOCKED_HOSTNAMES` Set in `ssrf.ts` is already global for the same reason.
**Instead:** Global blocklist state in `dns-blocklist.ts`, populated at startup. Per-request allowlist overrides (if ever needed) stay in `SsrFPolicy`.

### Anti-Pattern 4: Blocking at `isBlockedHostname()` Level

**What:** Adding blocklist checking to `isBlockedHostname()` or `isBlockedHostnameOrIp()`.
**Why bad:** These functions are used by `link-understanding/detect.ts` for URL extraction from messages, which is a read-only classification operation, not an outbound request. Blocking link detection would suppress legitimate URLs from being shown to users. The blocklist should only gate actual outbound network requests.
**Instead:** Insert at `resolvePinnedHostnameWithPolicy()`, which is exclusively used for outbound request authorization.

## Integration Points Catalog

All outbound HTTP surfaces that need blocklist coverage, ordered by risk:

| Surface | Current Guard | Blocklist Coverage | Notes |
|---------|--------------|-------------------|-------|
| Agent web-fetch tool | `fetchWithSsrFGuard` | Automatic (via `resolvePinnedHostnameWithPolicy`) | Highest risk: user/agent-controlled URLs |
| Browser navigation | `assertBrowserNavigationAllowed` | Automatic | Agent-controlled navigation targets |
| Media store (redirect follow) | `resolvePinnedHostnameWithPolicy` | Automatic | Media URL redirects |
| Link understanding | `isBlockedHostnameOrIp` (classify only) | NOT covered, intentionally | Read-only URL extraction, no outbound request |
| Channel API calls (Telegram, Discord, etc.) | Trusted first-party URLs | NOT covered, not needed | Hardcoded provider endpoints, not user-controlled |
| Provider API calls (OpenAI, Anthropic, etc.) | Trusted first-party URLs | NOT covered, not needed | Config-driven but operator-controlled endpoints |

The spike should hook `resolvePinnedHostnameWithPolicy` (covers the top 3 rows automatically) and document the remaining surfaces for future consideration.

## Suggested Build Order

Build order follows dependency chain and test-ability:

### Step 1: `dns-blocklist.ts` + `dns-blocklist.test.ts`

**Dependencies:** `normalizeHostname()` from `hostname.ts` only.
**Deliverables:**
- `isDomainBlocked(hostname): boolean`
- `assertDomainNotBlocked(hostname): void` (throws `SsrFBlockedError`)
- `setBlocklist(domains): void`
- `getBlocklistSize(): number` (for diagnostics)
- Hard-coded initial blocklist (small set of known-malicious test domains)
- Tests: exact match, subdomain match, non-match, normalization edge cases, empty blocklist, atomic swap

**Rationale:** Independently testable with zero integration risk. Establishes the matching algorithm and data structure.

### Step 2: Integration into `ssrf.ts`

**Dependencies:** Step 1.
**Deliverables:**
- Call `assertDomainNotBlocked(normalized)` at the top of `resolvePinnedHostnameWithPolicy()`, before existing Phase 1 checks
- Integration test in `ssrf.test.ts`: blocked domain throws `SsrFBlockedError`, non-blocked domain passes through

**Rationale:** Single-line integration at the chokepoint. All downstream consumers (`fetch-guard.ts`, `navigation-guard.ts`, etc.) inherit protection without changes.

### Step 3: Outbound HTTP surface catalog + verification tests

**Dependencies:** Step 2.
**Deliverables:**
- Integration test via `fetchWithSsrFGuard` proving end-to-end blocklist enforcement
- Document all outbound HTTP paths (the table above) in a code comment or test file
- Verify `navigation-guard.ts` path also blocks (test)

**Rationale:** Confirms the chokepoint strategy works for all consumer paths without per-consumer changes.

### Step 4 (Future): Config integration + remote list fetching

**Dependencies:** Steps 1-3.
**Deliverables:**
- `security.dnsBlocklists` config key
- Fetch + parse Hagezi-format blocklist files
- Periodic refresh with atomic Set swap
- Merge built-in + remote lists

**Rationale:** Deferred per PROJECT.md scope. Steps 1-3 are the spike; Step 4 is the polish PR.

## File Layout

```
src/infra/net/
  dns-blocklist.ts          # NEW: blocklist data structure + matching
  dns-blocklist.test.ts     # NEW: unit tests for matching logic
  ssrf.ts                   # MODIFIED: 1-line addition in resolvePinnedHostnameWithPolicy
  ssrf.test.ts              # MODIFIED: add integration test for blocklist
  fetch-guard.ts            # UNCHANGED
  hostname.ts               # UNCHANGED
```

## Sources

- Existing codebase: `src/infra/net/ssrf.ts` (two-phase SSRF guard pattern, `SsrFBlockedError`, `resolvePinnedHostnameWithPolicy` chokepoint)
- Existing codebase: `src/infra/net/fetch-guard.ts` (guarded fetch consumer pattern)
- Existing codebase: `src/browser/navigation-guard.ts` (browser navigation consumer pattern)
- Existing codebase: `src/plugin-sdk/ssrf-policy.ts` (suffix-based allowlist pattern, orthogonal to blocklists)
- Existing codebase: `src/infra/net/hostname.ts` (normalization used throughout)
- Existing codebase: `src/link-understanding/detect.ts` (read-only consumer of `isBlockedHostnameOrIp`, should NOT get blocklist)
- Pi-hole and AdGuard domain matching: label-walking / suffix-Set pattern is industry standard for DNS blocklist engines (HIGH confidence, well-established pattern)
