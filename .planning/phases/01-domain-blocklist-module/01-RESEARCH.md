# Phase 1: Domain Blocklist Module - Research

**Researched:** 2026-03-08
**Domain:** Domain suffix matching, Set-based lookups, TypeScript module design
**Confidence:** HIGH

## Summary

Phase 1 creates a standalone `isDomainBlocked()` function with suffix-based domain matching against a `Set<string>`. The codebase already contains all the patterns needed: `normalizeHostname()` for input normalization, `SsrFBlockedError` as the error base class, `BLOCKED_HOSTNAMES` as the Set pattern, and `ssrf.test.ts` for test organization style. This is a well-scoped, low-risk module with no external dependencies beyond what already exists.

The suffix-matching algorithm is the only non-trivial piece: walking up the domain label hierarchy (e.g., for `a.b.malware.test`, check `a.b.malware.test`, then `b.malware.test`, then `malware.test`, then `test`) against the Set. This is O(k) where k is the number of labels -- fast and correct for blocklist sizes up to millions of entries.

**Primary recommendation:** Follow the existing `ssrf.ts` patterns exactly. Reuse `normalizeHostname()`, extend `SsrFBlockedError`, use module-level `Set<string>`, co-locate tests.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Test-only domains using safe TLDs (.test, .bad), 5-8 domains exported as `DEFAULT_BLOCKED_DOMAINS`
- Module-level `Set<string>` constant with `setBlockedDomains()` swap function
- Error: `DnsBlocklistError` subclass extending `SsrFBlockedError` with message "Domain blocked by DNS blocklist: {domain}"
- API: `isDomainBlocked()`, `setBlockedDomains()`, `addBlockedDomain()`, `removeBlockedDomain()`, `DnsBlocklistError`, `DEFAULT_BLOCKED_DOMAINS`
- File: `src/infra/net/domain-filter.ts`, Test: `src/infra/net/domain-filter.test.ts`
- Reuse `normalizeHostname()` from `hostname.ts`
- Follow `ssrf.test.ts` fixture pattern (arrays of cases with descriptive names)

### Claude's Discretion
- Exact suffix-walking implementation details
- Test case organization and edge case selection
- Whether to normalize domains in setBlockedDomains/add/remove or require pre-normalized input

### Deferred Ideas (OUT OF SCOPE)
None
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MATCH-01 | Exact domain matching | Set.has() on normalized hostname; see Architecture Patterns |
| MATCH-02 | Subdomain matching | Suffix-walk algorithm; see Architecture Patterns |
| MATCH-03 | Hostname normalization | Reuse existing `normalizeHostname()` from `hostname.ts` |
| LIST-01 | Hard-coded starter blocklist with test domains | `DEFAULT_BLOCKED_DOMAINS` array with .test/.bad TLDs |
| LIST-02 | Atomic Set data structure | Module-level `let blockedDomains = new Set<string>(...)` with swap function |
| OBS-01 | Clear error message with blocked domain name | `DnsBlocklistError` extending `SsrFBlockedError` |
| TEST-01 | Unit tests for isDomainBlocked | Follow ssrf.test.ts pattern; see Validation Architecture |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | (project version) | Unit testing | Already configured in project |
| node:* | 22+ | No external deps needed | Pure TypeScript module, no dependencies |

### Supporting
No additional libraries needed. This module uses only:
- `normalizeHostname` from `./hostname.js` (existing)
- `SsrFBlockedError` from `./ssrf.js` (existing)

### Alternatives Considered
None. The CONTEXT.md locks all decisions. No external libraries are appropriate for this simple domain-matching task.

**Installation:**
```bash
# No new dependencies needed
```

## Architecture Patterns

### Recommended Project Structure
```
src/infra/net/
├── domain-filter.ts        # NEW: isDomainBlocked + Set management + DnsBlocklistError
├── domain-filter.test.ts   # NEW: unit tests
├── hostname.ts             # EXISTING: normalizeHostname (imported)
├── ssrf.ts                 # EXISTING: SsrFBlockedError (imported), integration point for Phase 2
└── ssrf.test.ts            # EXISTING: test pattern reference
```

### Pattern 1: Suffix-Walk Domain Matching
**What:** Walk up domain labels checking each suffix against the Set.
**When to use:** For every `isDomainBlocked()` call.
**Example:**
```typescript
// For input "sub.tracker.malware.test" with "malware.test" in blocklist:
// Check: "sub.tracker.malware.test" -> miss
// Check: "tracker.malware.test" -> miss
// Check: "malware.test" -> HIT, return true
// Check: "test" -> miss (would only reach here if previous didn't hit)

export function isDomainBlocked(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;

  // Exact match first (fast path)
  if (blockedDomains.has(normalized)) return true;

  // Suffix walk: strip one label at a time from the left
  let dot = normalized.indexOf(".");
  while (dot !== -1) {
    const suffix = normalized.slice(dot + 1);
    if (blockedDomains.has(suffix)) return true;
    dot = normalized.indexOf(".", dot + 1);
  }
  return false;
}
```

### Pattern 2: Module-Level Mutable Set with Atomic Swap
**What:** Module-scoped `let` binding for the Set, replaced atomically by `setBlockedDomains()`.
**When to use:** For the blocklist data structure.
**Example:**
```typescript
// Source: matches BLOCKED_HOSTNAMES pattern in ssrf.ts
export const DEFAULT_BLOCKED_DOMAINS: readonly string[] = [
  "malware.test",
  "phishing.test",
  "tracker.test",
  "adware.test",
  "cryptominer.test",
  "spyware.test",
  "blocked.bad",
];

let blockedDomains = new Set<string>(DEFAULT_BLOCKED_DOMAINS);

export function setBlockedDomains(domains: string[]): void {
  blockedDomains = new Set(domains.map(normalizeHostname).filter(Boolean));
}
```

### Pattern 3: Error Class Extension
**What:** `DnsBlocklistError` extending `SsrFBlockedError`.
**When to use:** When a blocked domain is detected and caller needs to throw.
**Example:**
```typescript
// Source: follows SsrFBlockedError pattern in ssrf.ts
export class DnsBlocklistError extends SsrFBlockedError {
  constructor(domain: string) {
    super(`Domain blocked by DNS blocklist: ${domain}`);
    this.name = "DnsBlocklistError";
  }
}
```

### Anti-Patterns to Avoid
- **Regex-based matching:** Explicitly out of scope per requirements. Suffix walking is simpler and correct.
- **Prototype mutation for test setup:** Use `setBlockedDomains()` in test setup/teardown, not module hacking.
- **Default exports:** Project uses named exports exclusively.
- **Missing `.js` extensions in imports:** ESM requires `.js` extensions on all import paths.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Hostname normalization | Custom trim/lowercase/dot logic | `normalizeHostname()` from `hostname.ts` | Already handles trim, lowercase, trailing dot, bracket stripping |
| Error hierarchy | New Error base class | Extend `SsrFBlockedError` from `ssrf.ts` | Callers already catch `SsrFBlockedError`; subclass preserves that |
| Test runner/assertions | Custom test helpers | Vitest `describe`/`it`/`expect` | Project standard |

**Key insight:** Almost everything needed already exists in the codebase. The new code is just the suffix-walk algorithm, the Set management API, and the error subclass.

## Common Pitfalls

### Pitfall 1: Forgetting to Normalize in Mutator Functions
**What goes wrong:** `addBlockedDomain("Malware.Test.")` adds un-normalized entry, then `isDomainBlocked("malware.test")` misses it.
**Why it happens:** Only normalizing in `isDomainBlocked` but not in add/set/remove.
**How to avoid:** Normalize in all mutator functions (`setBlockedDomains`, `addBlockedDomain`, `removeBlockedDomain`) AND in `isDomainBlocked`. Recommendation: normalize in mutators so the Set always contains normalized values.
**Warning signs:** Tests pass with exact-case inputs but fail with mixed-case mutations.

### Pitfall 2: TLD-Only Entries Blocking Everything
**What goes wrong:** Adding `"test"` to the blocklist blocks ALL `.test` domains including legitimate ones.
**Why it happens:** Suffix walk naturally reaches the TLD.
**How to avoid:** This is actually correct behavior for a blocklist (if `test` is in the list, all `.test` domains should be blocked). Document it but don't prevent it -- the caller controls what goes in the list.
**Warning signs:** Not a bug, but worth a test case to document the behavior.

### Pitfall 3: Empty String / Whitespace-Only Domains
**What goes wrong:** `isDomainBlocked("")` or `isDomainBlocked("  ")` could match against empty Set entries or cause unexpected behavior.
**Why it happens:** `normalizeHostname("")` returns `""`.
**How to avoid:** Guard on empty normalized result (return `false`). Filter empty strings from Set in mutators.
**Warning signs:** Empty string in Set causing false positives.

### Pitfall 4: Test Pollution Between Cases
**What goes wrong:** `addBlockedDomain()` in one test leaks into the next.
**Why it happens:** Module-level Set persists across tests.
**How to avoid:** Use `beforeEach`/`afterEach` to reset the blocklist via `setBlockedDomains(DEFAULT_BLOCKED_DOMAINS)`.
**Warning signs:** Tests pass individually but fail when run together.

## Code Examples

### Complete isDomainBlocked Implementation
```typescript
// Source: derived from existing ssrf.ts patterns + CONTEXT.md decisions
import { normalizeHostname } from "./hostname.js";
import { SsrFBlockedError } from "./ssrf.js";

export class DnsBlocklistError extends SsrFBlockedError {
  constructor(domain: string) {
    super(`Domain blocked by DNS blocklist: ${domain}`);
    this.name = "DnsBlocklistError";
  }
}

export const DEFAULT_BLOCKED_DOMAINS: readonly string[] = [
  "malware.test",
  "phishing.test",
  "tracker.test",
  "adware.test",
  "cryptominer.test",
  "spyware.test",
  "blocked.bad",
];

let blockedDomains = new Set<string>(DEFAULT_BLOCKED_DOMAINS);

export function isDomainBlocked(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;
  if (blockedDomains.has(normalized)) return true;

  let dot = normalized.indexOf(".");
  while (dot !== -1) {
    const suffix = normalized.slice(dot + 1);
    if (suffix && blockedDomains.has(suffix)) return true;
    dot = normalized.indexOf(".", dot + 1);
  }
  return false;
}

export function setBlockedDomains(domains: string[]): void {
  blockedDomains = new Set(
    domains.map((d) => normalizeHostname(d)).filter(Boolean),
  );
}

export function addBlockedDomain(domain: string): void {
  const normalized = normalizeHostname(domain);
  if (normalized) blockedDomains.add(normalized);
}

export function removeBlockedDomain(domain: string): void {
  const normalized = normalizeHostname(domain);
  if (normalized) blockedDomains.delete(normalized);
}
```

### Test Structure (following ssrf.test.ts pattern)
```typescript
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BLOCKED_DOMAINS,
  DnsBlocklistError,
  addBlockedDomain,
  isDomainBlocked,
  removeBlockedDomain,
  setBlockedDomains,
} from "./domain-filter.js";

const exactMatchCases = ["malware.test", "phishing.test", "blocked.bad"];
const subdomainMatchCases = [
  "sub.malware.test",
  "deep.sub.phishing.test",
  "a.b.c.tracker.test",
];
const nonBlockedCases = [
  "example.com",
  "google.com",
  "safe.test.example.com", // "test" appears but not as suffix match
  "notmalware.test",       // different domain, same TLD -- NOT a subdomain of malware.test
];
const normalizationCases = [
  { input: "MALWARE.TEST", expected: true, label: "uppercase" },
  { input: "malware.test.", expected: true, label: "trailing dot" },
  { input: "  malware.test  ", expected: true, label: "whitespace" },
  { input: "", expected: false, label: "empty string" },
  { input: "   ", expected: false, label: "whitespace only" },
];

afterEach(() => {
  setBlockedDomains([...DEFAULT_BLOCKED_DOMAINS]);
});

describe("isDomainBlocked", () => {
  // ... test cases using the arrays above
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Regex domain matching | Suffix-walk against Set | Industry standard | Simpler, faster, no regex edge cases |
| Trie-based lookup | Set + suffix walk | N/A | Trie only worthwhile for >100K domains; Set is correct here |

**Note on scaling:** For the starter list (5-8 domains), `Set.has()` with suffix walking is optimal. If the list grows to hundreds of thousands of entries (remote blocklists in v2), the same algorithm still works -- `Set.has()` is O(1) and suffix walk is O(k) where k is label count (typically 2-5). No need to pre-optimize.

## Open Questions

1. **Should `isDomainBlocked` also export a throwing variant?**
   - What we know: CONTEXT.md defines `DnsBlocklistError` but doesn't specify a throwing function
   - What's unclear: Whether Phase 2 integration wants `isDomainBlocked` (returns bool) + manual throw, or a convenience `assertDomainNotBlocked` that throws
   - Recommendation: Export only `isDomainBlocked` (bool) and `DnsBlocklistError` (class). Phase 2 can create a throwing wrapper at the integration site if needed. Keep Phase 1 minimal.

2. **Normalization in `removeBlockedDomain`**
   - What we know: User left normalization strategy as Claude's discretion
   - Recommendation: Normalize in all mutators for consistency. This means `addBlockedDomain("MALWARE.TEST")` and `removeBlockedDomain("malware.test")` work as expected.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (project version) |
| Config file | Exists (project-level vitest config) |
| Quick run command | `pnpm test src/infra/net/domain-filter.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MATCH-01 | Exact domain match returns true | unit | `pnpm test src/infra/net/domain-filter.test.ts` | No -- Wave 0 |
| MATCH-02 | Subdomain of blocked domain returns true | unit | `pnpm test src/infra/net/domain-filter.test.ts` | No -- Wave 0 |
| MATCH-03 | Normalization (case, trailing dot, whitespace) | unit | `pnpm test src/infra/net/domain-filter.test.ts` | No -- Wave 0 |
| LIST-01 | DEFAULT_BLOCKED_DOMAINS contains test domains | unit | `pnpm test src/infra/net/domain-filter.test.ts` | No -- Wave 0 |
| LIST-02 | setBlockedDomains atomically replaces Set | unit | `pnpm test src/infra/net/domain-filter.test.ts` | No -- Wave 0 |
| OBS-01 | DnsBlocklistError includes domain name | unit | `pnpm test src/infra/net/domain-filter.test.ts` | No -- Wave 0 |
| TEST-01 | All unit test cases pass | unit | `pnpm test src/infra/net/domain-filter.test.ts` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test src/infra/net/domain-filter.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before verify

### Wave 0 Gaps
- [ ] `src/infra/net/domain-filter.test.ts` -- covers MATCH-01, MATCH-02, MATCH-03, LIST-01, LIST-02, OBS-01, TEST-01
- No framework install needed -- Vitest already configured
- No shared fixtures needed -- test arrays are self-contained (following ssrf.test.ts pattern)

## Sources

### Primary (HIGH confidence)
- `src/infra/net/ssrf.ts` -- SsrFBlockedError pattern, BLOCKED_HOSTNAMES Set pattern, module structure
- `src/infra/net/hostname.ts` -- normalizeHostname implementation (trim, lowercase, trailing dot, brackets)
- `src/infra/net/ssrf.test.ts` -- test organization pattern (case arrays, describe/it blocks)
- `.planning/phases/01-domain-blocklist-module/01-CONTEXT.md` -- locked decisions, API surface, file placement

### Secondary (MEDIUM confidence)
- None needed -- all patterns are from the existing codebase

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, everything exists in codebase
- Architecture: HIGH -- suffix-walk is a well-known algorithm, Set pattern already in ssrf.ts
- Pitfalls: HIGH -- common Set/normalization gotchas are well-documented in the industry

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable domain, no external dependencies)
