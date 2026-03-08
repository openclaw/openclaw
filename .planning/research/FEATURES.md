# Feature Landscape: DNS Blocklist Filtering

**Domain:** DNS blocklist filtering for AI agent gateway outbound HTTP
**Researched:** 2026-03-08

## Table Stakes

Features users expect. Missing = the feature feels incomplete or insecure.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Exact domain matching | Core blocklist semantics; "block evil.com" must block `evil.com` | Low | Already patterned in `BLOCKED_HOSTNAMES` Set in `ssrf.ts` |
| Subdomain matching | `evil.com` in blocklist must also block `sub.evil.com`, `a.b.evil.com` | Low | Suffix-based matching already exists in `ssrf-policy.ts`; reuse that pattern |
| Hostname normalization | Trailing dots, mixed case, bracket-wrapped IPv6 must not bypass | Low | `normalizeHostname()` in `hostname.ts` already handles this |
| Fail-closed on parse errors | Malformed hostnames that cannot be normalized must be blocked, not passed through | Low | Existing SSRF infra already does this for IPs; extend to blocklist path |
| Deterministic error type | Blocked-by-blocklist must produce a typed error the caller can distinguish from network failures | Low | Extend `SsrFBlockedError` with a subclass or reason field |
| Integration with existing SSRF phase 1 | Blocklist check runs pre-DNS (phase 1 of the two-phase SSRF model) so no DNS lookup side-effects occur | Low | Natural insertion point in `resolvePinnedHostnameWithPolicy` before DNS lookup |
| Hard-coded starter list | Ship with a small built-in blocklist of known-bad domains for immediate value | Low | Embed as a `Set<string>` in the module; can be augmented later |
| Unit tests for matching logic | Exact match, subdomain match, normalization edge cases, non-matching domains pass through | Low | Follow existing patterns in `ssrf.test.ts` |
| Integration test proving blocked fetch fails | End-to-end test that a fetch through the guarded path produces `SsrFBlockedError` | Medium | Needs test harness wiring similar to `web-fetch.ssrf.test.ts` |

## Differentiators

Features that go beyond basic blocklisting. Not expected in a spike but add real value for an AI agent gateway.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Remote blocklist fetching (Hagezi, StevenBlack, etc.) | Real-world blocklists have thousands of entries maintained by the community; fetching them means the gateway stays current without code changes | Medium | Parse hosts-file format (`0.0.0.0 domain` or `127.0.0.1 domain`); fetch on startup + periodic refresh; cache locally |
| Config-driven blocklist sources | `security.dnsBlocklists.sources: [url1, url2]` lets operators choose which lists to use | Medium | Zod schema addition to `config/zod-schema.ts`; validation that URLs are HTTPS |
| Config-driven custom entries | `security.dnsBlocklists.custom: [domain1, domain2]` for operator-specific blocks | Low | Simple array merged into the loaded blocklist Set |
| Allowlist override | `security.dnsBlocklists.allowlist: [domain]` to exempt specific domains even if they appear on a blocklist | Low | Check allowlist before blocklist; important for false-positive handling |
| Periodic refresh with TTL | Blocklists fetched from URLs auto-refresh on a configurable interval (e.g., every 24h) | Medium | Timer-based refresh; atomic swap of the active Set; stale-on-error (keep old list if fetch fails) |
| Blocklist statistics / observability | Log or expose metrics: how many domains loaded, how many requests blocked, which domains hit most | Medium | Useful for operators to understand what the filter is doing; counter in gateway status |
| Per-tool or per-agent policy | Different agents or tools get different blocklist policies (e.g., browser tool gets stricter list) | High | Needs policy resolution per request context; deferred to future work per PROJECT.md |
| Wildcard / pattern entries | Support `*.evil.tld` patterns in custom blocklists beyond simple suffix matching | Low | Already have `isHostnameAllowedByPattern` for wildcards; invert for blocking |
| IDN / punycode normalization | Internationalized domain names must be normalized to ASCII before matching to prevent bypass via unicode domains | Medium | Use `url.domainToASCII()` or similar; important for security but edge-case-heavy |
| Dry-run / audit mode | Log what would be blocked without actually blocking; useful for operators evaluating a new list | Low | Boolean flag that changes behavior from throw to warn+allow |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Full DNS sinkhole / resolver replacement | OpenClaw is an application gateway, not a network-level DNS filter like Pi-hole; replacing DNS resolution adds massive complexity and breaks DNS pinning | Keep the blocklist as a hostname check in the application layer, before DNS resolution (phase 1) |
| Regex-based domain matching | Regex on every domain check is a performance footgun (ReDoS risk) and hard to reason about for operators | Use exact + suffix matching only; it covers all real blocklist use cases |
| Blocklist as a standalone microservice | Adds deployment complexity, network hop latency, and a new failure mode for zero benefit in a single-gateway architecture | Keep it in-process as a Set lookup; sub-microsecond performance |
| User-facing blocklist management UI | The gateway is headless / CLI-configured; a web UI for managing blocklists is scope creep | Config file + CLI commands are the right interface |
| IP-address-based blocklists | The existing SSRF infrastructure already handles IP blocking comprehensively (private ranges, special-use addresses, post-DNS resolution checks); duplicating IP blocking in the domain blocklist adds confusion | Domain blocklist handles hostnames only; IP blocking stays in SSRF module |
| Real-time threat intelligence feeds | Commercial threat intel APIs (VirusTotal, etc.) add cost, latency, and external dependencies | Use community-maintained static blocklists (Hagezi, StevenBlack) that are free, fast, and sufficient |
| Per-user blocklist customization | Individual users of the gateway should not control security policy; that is an operator concern | Operator-level config only via `security.dnsBlocklists.*` |
| Blocking based on URL path or query string | This is URL filtering, not DNS blocklisting; different concern, different module | If needed later, implement as a separate URL policy layer |

## Feature Dependencies

```
Hard-coded starter list --> Exact domain matching (requires matching logic)
Exact domain matching --> Subdomain matching (extends matching)
Exact domain matching --> Hostname normalization (requires normalization)
Exact domain matching --> Fail-closed on parse errors (requires error handling)
Integration with SSRF phase 1 --> Deterministic error type (requires error type)
Integration with SSRF phase 1 --> Exact domain matching (requires matching)

Remote blocklist fetching --> Config-driven blocklist sources (needs config for URLs)
Remote blocklist fetching --> Periodic refresh with TTL (needs refresh mechanism)
Config-driven custom entries --> Allowlist override (allowlist checks custom + remote)

Allowlist override --> Remote blocklist fetching (most useful when external lists have false positives)
```

## MVP Recommendation

The spike (milestone 1) should deliver all table stakes features. They are all low-to-medium complexity and map directly to the existing SSRF infrastructure patterns.

Prioritize:
1. **Exact + subdomain matching with normalization** - Core logic, reuses existing patterns
2. **Fail-closed error handling extending SsrFBlockedError** - Consistent with existing error model
3. **Integration into SSRF phase 1** - Single insertion point in `resolvePinnedHostnameWithPolicy`
4. **Hard-coded starter list** - Immediate value, proves the integration works
5. **Unit + integration tests** - Validates correctness, follows existing test patterns

Defer to subsequent PR:
- **Remote blocklist fetching**: Needs hosts-file parsing, HTTP fetching, caching, error handling. Medium complexity, clear module boundary.
- **Config integration** (`security.dnsBlocklists.*`): Needs Zod schema changes, config validation, migration path. Should ship with remote fetching.
- **Allowlist override**: Most valuable alongside remote lists where false positives are a real concern.
- **Per-agent policy**: Explicitly out of scope per PROJECT.md.

## Sources

- `src/infra/net/ssrf.ts` - Existing SSRF infrastructure with two-phase check model, `SsrFBlockedError`, hostname normalization
- `src/infra/net/hostname.ts` - `normalizeHostname()` function
- `src/plugin-sdk/ssrf-policy.ts` - Suffix-based hostname allowlisting patterns
- `src/config/zod-schema.ts` - Existing config schema with `hostnameAllowlist` and security patterns
- `.planning/PROJECT.md` - Project scope and constraints
- Community blocklist projects (Hagezi, StevenBlack hosts) - Standard hosts-file format for domain blocklists (MEDIUM confidence, based on well-established community knowledge)
