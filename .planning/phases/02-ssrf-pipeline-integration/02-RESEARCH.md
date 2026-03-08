# Phase 2: SSRF Pipeline Integration - Research

**Researched:** 2026-03-08
**Domain:** SSRF guard integration, Vitest integration testing
**Confidence:** HIGH

## Summary

This phase wires the `isDomainBlocked()` guard from Phase 1's `domain-filter.ts` into the SSRF pipeline's `resolvePinnedHostnameWithPolicy()` function. The production change is two lines of code: one `if` check and one `throw`. The integration tests prove end-to-end blocking through the SSRF pipeline using mock DNS lookups, following the established pattern in `ssrf.pinning.test.ts`.

All building blocks exist. `isDomainBlocked()` and `DnsBlocklistError` are implemented and tested. The insertion point in `ssrf.ts` is clearly identified (after line 283, before allowlist checks). The test file already has mock DNS patterns that the new tests will follow.

**Primary recommendation:** Insert the blocklist check at line 284 of `ssrf.ts`, add a new describe block to `ssrf.pinning.test.ts`, and verify `DnsBlocklistError instanceof SsrFBlockedError` in tests.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

- Blocklist is a security floor -- always enforced, never bypassable by allowlist entries
- Same error message regardless of whether domain is also in an allowlist ("Domain blocked by DNS blocklist: {domain}")
- No policy-level opt-out (e.g., skipDnsBlocklist) in v1
- Check applies to both `resolvePinnedHostnameWithPolicy()` and `resolvePinnedHostname()` (the latter delegates to the former, so it's automatic)
- Blocklist check goes first in `resolvePinnedHostnameWithPolicy()`, immediately after hostname normalization and the null check (after line 283)
- Fires before hostnameAllowlist check, before private-network checks, before DNS lookup
- Uses the already-normalized hostname from line 280, passes normalized value to `DnsBlocklistError`
- Only in the new insertion point -- do not modify `isBlockedHostnameOrIp()` or `assertAllowedHostOrIpOrThrow()`
- Static import of `isDomainBlocked` and `DnsBlocklistError` from `./domain-filter.js` at top of ssrf.ts
- Tests live in `ssrf.pinning.test.ts` as a new describe block
- Mock DNS lookup to prove blocklist fires pre-DNS
- Include regression test: non-blocked domain passes through to DNS lookup successfully
- Verify DnsBlocklistError instanceof SsrFBlockedError

### Claude's Discretion

- Test case organization within the new describe block
- Whether to add afterEach cleanup for blocklist state in integration tests
- Exact number of integration test cases beyond the required three (blocked, non-blocked regression, instanceof)

### Deferred Ideas (OUT OF SCOPE)

None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>

## Phase Requirements

| ID      | Description                                                                  | Research Support                                                                                            |
| ------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| SSRF-01 | Blocklist check wired into `resolvePinnedHostnameWithPolicy()` pre-DNS       | Insertion point at line 284 of ssrf.ts confirmed; `isDomainBlocked` and `DnsBlocklistError` ready to import |
| TEST-02 | Integration test proving blocked hostname causes error through SSRF pipeline | Mock DNS pattern from ssrf.pinning.test.ts verified; new describe block with 3+ test cases                  |

</phase_requirements>

## Standard Stack

### Core

| Library | Version           | Purpose        | Why Standard                                |
| ------- | ----------------- | -------------- | ------------------------------------------- |
| vitest  | (project default) | Test framework | Already used for all tests in this codebase |

### Supporting

| Library            | Version        | Purpose                                                                                  | When to Use                         |
| ------------------ | -------------- | ---------------------------------------------------------------------------------------- | ----------------------------------- |
| `domain-filter.ts` | Phase 1 output | `isDomainBlocked()`, `DnsBlocklistError`, `DEFAULT_BLOCKED_DOMAINS`, `setBlockedDomains` | Production check and test utilities |

No new dependencies needed. This phase uses only existing project code and test infrastructure.

## Architecture Patterns

### Insertion Point

```
src/infra/net/ssrf.ts  (line ~284, after null check)
```

The check slots into `resolvePinnedHostnameWithPolicy()` as the very first guard after hostname normalization:

```typescript
// Source: ssrf.ts lines 276-298 (with insertion)
export async function resolvePinnedHostnameWithPolicy(
  hostname: string,
  params: { lookupFn?: LookupFn; policy?: SsrFPolicy } = {},
): Promise<PinnedHostname> {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    throw new Error("Invalid hostname");
  }

  // >>> NEW: DNS blocklist check (security floor, pre-everything) <<<
  if (isDomainBlocked(normalized)) {
    throw new DnsBlocklistError(normalized);
  }

  // existing: allowlist, private-network, DNS lookup...
}
```

### Guard Ordering in resolvePinnedHostnameWithPolicy()

Current order (after this phase):

1. Hostname normalization + null check (existing)
2. **DNS blocklist check** (NEW -- this phase)
3. Hostname allowlist check (existing)
4. Private-network pre-DNS check (existing)
5. DNS lookup (existing)
6. Private-network post-DNS check (existing)

The blocklist fires first because it is a security floor -- no policy can override it.

### Import Pattern

All sibling imports in `ssrf.ts` use `.js` ESM extensions:

```typescript
import { isDomainBlocked, DnsBlocklistError } from "./domain-filter.js";
```

### Test Pattern (from existing ssrf.pinning.test.ts)

The established mock DNS pattern:

```typescript
// Source: ssrf.pinning.test.ts lines 10-12
function createPublicLookupMock(): LookupFn {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
}
```

Integration tests use `resolvePinnedHostnameWithPolicy` with a mock `lookupFn` and assert:

- `rejects.toThrow(ErrorClass)` for blocked cases
- `expect(lookup).not.toHaveBeenCalled()` to prove pre-DNS rejection
- `resolves.toMatchObject(...)` for non-blocked cases

### Test State Isolation

`domain-filter.test.ts` uses `afterEach` to reset blocklist state:

```typescript
afterEach(() => {
  setBlockedDomains([...DEFAULT_BLOCKED_DOMAINS]);
});
```

The integration tests in `ssrf.pinning.test.ts` should follow the same pattern if any test modifies blocklist state. For tests that only read the default blocklist (using `.test` domains), no cleanup is needed.

## Don't Hand-Roll

| Problem               | Don't Build             | Use Instead                                                  | Why                                                     |
| --------------------- | ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| Domain matching logic | Custom check in ssrf.ts | `isDomainBlocked()` from domain-filter.ts                    | Already handles normalization, exact match, suffix walk |
| Error class           | New error in ssrf.ts    | `DnsBlocklistError` from domain-filter.ts                    | Already extends SsrFBlockedError, formats message       |
| Mock DNS in tests     | Custom promise wrapper  | `createPublicLookupMock()` pattern from ssrf.pinning.test.ts | Established, type-safe, already tested                  |

## Common Pitfalls

### Pitfall 1: Wrong insertion point ordering

**What goes wrong:** Placing the blocklist check after the allowlist check would let allowlisted blocked domains through.
**Why it happens:** The allowlist check at line 291 looks like it should come first.
**How to avoid:** Insert at line 284, immediately after the null check. The blocklist is a security floor.
**Warning signs:** A test where a domain in both blocklist and allowlist passes through.

### Pitfall 2: Double normalization

**What goes wrong:** Calling `isDomainBlocked()` with the raw `hostname` parameter instead of `normalized`.
**Why it happens:** `isDomainBlocked()` internally normalizes, so it would still work, but it wastes cycles and diverges from the pattern.
**How to avoid:** Pass `normalized` (already computed at line 280). Use `DnsBlocklistError(normalized)` too.

### Pitfall 3: Forgetting ESM .js extension

**What goes wrong:** Import fails at runtime.
**Why it happens:** TypeScript files import with `.js` extension in ESM.
**How to avoid:** Use `from "./domain-filter.js"` (not `.ts`).

### Pitfall 4: Test state leakage

**What goes wrong:** A test that mutates the blocklist via `addBlockedDomain`/`setBlockedDomains` contaminates subsequent tests.
**Why it happens:** The blocklist is module-level mutable state.
**How to avoid:** Add `afterEach` cleanup if any test modifies blocklist state. Default blocklist domains (`.test`, `.bad`) are safe to assert against without cleanup.

## Code Examples

### Production Code Change (2 lines + import)

```typescript
// ssrf.ts top-level imports -- add:
import { isDomainBlocked, DnsBlocklistError } from "./domain-filter.js";

// Inside resolvePinnedHostnameWithPolicy(), after line 283:
if (isDomainBlocked(normalized)) {
  throw new DnsBlocklistError(normalized);
}
```

### Integration Test: Blocked Domain (pre-DNS proof)

```typescript
// Source: pattern from ssrf.pinning.test.ts line 102-113
it("rejects blocked domains before DNS lookup", async () => {
  const lookup = createPublicLookupMock();
  await expect(
    resolvePinnedHostnameWithPolicy("malware.test", { lookupFn: lookup }),
  ).rejects.toThrow(DnsBlocklistError);
  expect(lookup).not.toHaveBeenCalled();
});
```

### Integration Test: Non-blocked Regression

```typescript
it("allows non-blocked domains through to DNS", async () => {
  const lookup = createPublicLookupMock();
  const pinned = await resolvePinnedHostnameWithPolicy("example.com", { lookupFn: lookup });
  expect(pinned.hostname).toBe("example.com");
  expect(lookup).toHaveBeenCalledTimes(1);
});
```

### Integration Test: Error Hierarchy

```typescript
it("DnsBlocklistError is an instance of SsrFBlockedError", async () => {
  const lookup = createPublicLookupMock();
  await expect(
    resolvePinnedHostnameWithPolicy("malware.test", { lookupFn: lookup }),
  ).rejects.toBeInstanceOf(SsrFBlockedError);
});
```

## Validation Architecture

### Test Framework

| Property           | Value                                             |
| ------------------ | ------------------------------------------------- |
| Framework          | Vitest (project default)                          |
| Config file        | vitest config in package.json or vitest.config.\* |
| Quick run command  | `pnpm test src/infra/net/ssrf.pinning.test.ts`    |
| Full suite command | `pnpm test`                                       |

### Phase Requirements to Test Map

| Req ID  | Behavior                                                                     | Test Type   | Automated Command                              | File Exists?                       |
| ------- | ---------------------------------------------------------------------------- | ----------- | ---------------------------------------------- | ---------------------------------- |
| SSRF-01 | Blocked domain rejected pre-DNS in resolvePinnedHostnameWithPolicy           | integration | `pnpm test src/infra/net/ssrf.pinning.test.ts` | Exists (new describe block needed) |
| TEST-02 | Integration test proving blocked hostname causes error through SSRF pipeline | integration | `pnpm test src/infra/net/ssrf.pinning.test.ts` | Exists (new describe block needed) |

### Sampling Rate

- **Per task commit:** `pnpm test src/infra/net/ssrf.pinning.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

None -- existing test infrastructure covers all phase requirements. The test file `ssrf.pinning.test.ts` exists; a new `describe` block will be added within it.

## Sources

### Primary (HIGH confidence)

- Direct source code inspection of `src/infra/net/ssrf.ts` (insertion point, function signature, guard ordering)
- Direct source code inspection of `src/infra/net/domain-filter.ts` (Phase 1 output, API surface)
- Direct source code inspection of `src/infra/net/ssrf.pinning.test.ts` (test patterns, mock DNS approach)
- Direct source code inspection of `src/infra/net/domain-filter.test.ts` (state cleanup pattern)

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH - no new deps, all code exists
- Architecture: HIGH - insertion point verified in source, guard ordering confirmed
- Pitfalls: HIGH - patterns observed directly in codebase

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable -- no external dependencies)
