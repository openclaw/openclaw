# Research Summary: DNS Blocklist Filtering

**Domain:** DNS blocklist filtering for AI agent gateway outbound HTTP
**Researched:** 2026-03-08
**Overall confidence:** HIGH (codebase analysis) / MEDIUM (external ecosystem claims)

## Executive Summary

DNS blocklist filtering for OpenClaw's gateway is a well-understood problem with a straightforward implementation path. The existing SSRF infrastructure in `src/infra/net/ssrf.ts` already provides the exact integration point needed: a two-phase hostname/IP check with `resolvePinnedHostnameWithPolicy()` as the single chokepoint for all outbound requests. The blocklist is a pure Phase 1 (pre-DNS) string-matching addition that requires zero new dependencies.

The recommended approach is a `Set<string>` with label-based suffix walking for subdomain matching. This handles 200K+ domains in sub-microsecond lookup time. No npm library is needed or recommended -- the matching logic is ~30 lines of TypeScript, and the existing `normalizeHostname()` function already handles all normalization concerns. External DNS blocklist packages on npm are either abandoned, designed for DNS server use cases, or pull in unnecessary dependencies.

For blocklist sources, the domains-only text format (one domain per line, `#` comments) is the clear choice. It is the simplest to parse and is natively provided by all major community blocklist projects (Hagezi, OISD, StevenBlack). The spike should use a small hard-coded list; remote list fetching is explicitly deferred per project scope.

The critical architectural decision is where to insert the check: it must go inside `resolvePinnedHostnameWithPolicy()`, not alongside it and not in the lower-level `isBlockedHostname()` function (which is used for read-only URL classification in link detection). This single insertion point automatically protects all 36+ callers including web-fetch tools, browser navigation, media fetching, and plugin SDK fetches.

## Key Findings

**Stack:** No new dependencies. `Set<string>` with suffix walking, reusing existing `normalizeHostname()` and `SsrFBlockedError`. Domains-only list format.

**Architecture:** New `dns-blocklist.ts` sibling to `ssrf.ts`. Single integration point in `resolvePinnedHostnameWithPolicy()` before existing Phase 1 checks. All downstream consumers inherit protection automatically.

**Critical pitfall:** Inserting the blocklist check at the wrong level (in `isBlockedHostname` instead of `resolvePinnedHostnameWithPolicy`) would either break link detection or leave outbound requests unprotected.

## Implications for Roadmap

Based on research, suggested phase structure:

1. **Core matching + integration (spike)** - Build `isDomainBlocked()` with suffix walking, integrate into SSRF Phase 1, hard-coded starter list, full unit + integration tests.
   - Addresses: exact domain matching, subdomain matching, normalization, error types, SSRF integration
   - Avoids: creating a parallel system (Pitfall 3), normalization mismatch (Pitfall 2), wrong chokepoint (Pitfall 1/Architecture)

2. **Outbound surface catalog + verification** - Map all outbound HTTP paths, verify coverage through the chokepoint, add end-to-end tests through `fetchWithSsrFGuard`.
   - Addresses: documenting all HTTP surfaces, confirming automatic coverage
   - Avoids: incomplete coverage assumption

3. **Config integration (future PR)** - Add `security.dnsBlocklists` config schema, local file list loading, custom domain entries, allowlist override.
   - Addresses: operator configurability, custom domain blocking
   - Avoids: premature complexity in spike

4. **Remote list fetching (future PR)** - Fetch Hagezi/OISD lists from URLs, periodic refresh with atomic Set swap, stale-while-revalidate pattern.
   - Addresses: real-world blocklist coverage (200K+ domains)
   - Avoids: startup blocking (async fetch), fail-open on errors (fallback to built-in list)

**Phase ordering rationale:**
- Phase 1-2 are the spike scope (per PROJECT.md): prove the integration works with a small list
- Phase 3 adds config before remote fetching because config defines where lists come from
- Phase 4 depends on config and adds the most operational complexity (HTTP fetching, caching, refresh)
- Each phase is independently shippable and useful

**Research flags for phases:**
- Phase 1-2: Standard patterns, well-understood from codebase analysis. Unlikely to need research.
- Phase 3: May need research on config schema conventions if `security.*` namespace doesn't exist yet. Check `src/config/zod-schema.ts`.
- Phase 4: Will need research to verify current Hagezi/OISD URLs and format details. Domain counts and list availability should be verified at implementation time.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Zero dependencies; built entirely on existing infrastructure verified in code |
| Features | HIGH | Table stakes derived from SSRF module analysis; differentiators from established patterns |
| Architecture | HIGH | Integration point verified by tracing all callers of `resolvePinnedHostnameWithPolicy` |
| Pitfalls | HIGH (codebase) / MEDIUM (ecosystem) | Codebase-specific pitfalls verified in code; blocklist format claims based on training data |
| Blocklist sources | MEDIUM | Hagezi/OISD/StevenBlack are well-established but exact URLs, domain counts, and format details should be verified when implementing remote fetching |

## Gaps to Address

- Exact current URLs for Hagezi domains-only format downloads (verify at Phase 4 implementation time)
- Current domain counts for major blocklists (training data estimates; verify when fetching)
- IDN/punycode normalization strategy (deferred; document as known gap)
- Public suffix validation for loaded lists (needed at Phase 3-4; may want `publicsuffix-list` or similar)
- Interaction with future per-agent/per-tool policies (explicitly out of scope per PROJECT.md)
