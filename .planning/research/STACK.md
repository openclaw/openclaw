# Technology Stack

**Project:** DNS Blocklist Filtering for OpenClaw Gateway
**Researched:** 2026-03-08
**Note:** All external research tools were unavailable. Recommendations are based on training data (cutoff ~May 2025) and direct codebase analysis. Confidence levels reflect this.

## Recommended Stack

### Core Approach: No External Libraries

**Recommendation:** Build domain matching in-house using a `Set<string>` with suffix walking. Do NOT pull in an npm library for this.

**Rationale:**
- The matching logic is trivial (~30 LOC): normalize hostname, check exact match, walk parent domains (strip leftmost label, check again)
- OpenClaw already has `normalizeHostname()` in `src/infra/net/hostname.ts` and suffix-based matching patterns in `src/plugin-sdk/ssrf-policy.ts`
- External DNS blocklist npm packages are either abandoned, bloated (pulling in DNS resolver dependencies), or designed for DNS server use cases (Pi-hole clones), not HTTP gateway middleware
- The SSRF module already demonstrates the exact pattern: `Set<string>` lookup with normalized hostnames
- Zero new dependencies = zero supply chain risk for a security-critical path

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `Set<string>` (built-in) | Node 22+ | Domain lookup | O(1) exact match; handles 300K+ domains without issue; already used in ssrf.ts | HIGH |
| `normalizeHostname()` (existing) | N/A | Hostname normalization | Already strips trailing dots, lowercases, handles bracket IPv6; reuse, don't duplicate | HIGH |
| `node:fs/promises` | Node 22+ | Read local blocklist files | For bundled/cached list files; no new dependency needed | HIGH |

### Blocklist Sources

Use the "domains-only" format from established community blocklists. These are plain text files with one domain per line.

| Source | List | Domain Count (approx.) | Purpose | Confidence |
|--------|------|----------------------|---------|------------|
| Hagezi | Multi Pro | ~170K domains | Best general-purpose blocklist; actively maintained; well-categorized | MEDIUM |
| Hagezi | Threat Intelligence Feeds (TIF) | ~100K domains | Malware/phishing focused; good for security-critical filtering | MEDIUM |
| OISD | Big list | ~200K domains | Cross-referenced aggregation; good overlap validation | MEDIUM |
| StevenBlack | Unified hosts | ~180K domains | Long-running, well-known; hosts-file format (needs parsing) | MEDIUM |

**Recommendation for initial spike:** Start with Hagezi Multi Pro in domains-only format. It is the most actively maintained, provides multiple format outputs, and has the best signal-to-noise ratio.

**Recommendation for the spike phase specifically:** Hard-code a small curated list (10-50 known-bad domains) to validate the integration point. Remote list fetching is explicitly out of scope per PROJECT.md.

### List Formats

| Format | Extension | Example Line | Parse Complexity | Use? |
|--------|-----------|-------------|------------------|------|
| **Domains-only** | `.txt` | `malware.example.com` | Trivial: one domain per line, skip `#` comments and blanks | YES - use this |
| Hosts file | `hosts` | `0.0.0.0 malware.example.com` | Easy: split on whitespace, take second field, skip `#` | NO - unnecessary complexity |
| Adblock filter | `.txt` | `\|\|malware.example.com^` | Moderate: strip `\|\|` prefix and `^` suffix, handle exceptions (`@@`) | NO - designed for browser ad blocking |
| RPZ (DNS zone) | `.rpz` | `malware.example.com CNAME .` | Complex: DNS zone file parsing | NO - for DNS servers |
| ABP/uBlock | `.txt` | Various rule syntax | Complex: full filter engine | NO - wrong domain entirely |

**Use domains-only format exclusively.** It is the simplest to parse, widely available from all major blocklist providers, and maps directly to `Set<string>` lookup.

### Parser Implementation

```typescript
// ~15 lines, no library needed
function parseDomainsList(content: string): Set<string> {
  const domains = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      continue;
    }
    const normalized = normalizeHostname(trimmed);
    if (normalized) {
      domains.add(normalized);
    }
  }
  return domains;
}
```

### Domain Matching Algorithm

```typescript
// Subdomain matching via suffix walking (~10 lines)
function isDomainBlocked(hostname: string, blocklist: Set<string>): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;

  // Check exact match and all parent domains
  let domain = normalized;
  while (domain) {
    if (blocklist.has(domain)) return true;
    const dot = domain.indexOf(".");
    if (dot === -1) break;
    domain = domain.slice(dot + 1);
  }
  return false;
}
```

**Why suffix walking over a Trie:** At 200K domains, `Set.has()` with suffix walking does at most ~6 lookups per check (average domain depth). This is sub-microsecond. A Trie would be faster for millions of domains but adds implementation complexity for zero measurable benefit at this scale. The existing SSRF code uses `Set` for the same reason.

### Integration Point

| Component | File | Integration | Confidence |
|-----------|------|-------------|------------|
| SSRF pre-DNS check | `src/infra/net/ssrf.ts` | Add blocklist check in `assertAllowedHostOrIpOrThrow()` or a new function called from `resolvePinnedHostnameWithPolicy()` | HIGH |
| `SsrFBlockedError` | `src/infra/net/ssrf.ts` | Reuse existing error class; message like `"Blocked: domain is on DNS blocklist"` | HIGH |
| Hostname normalization | `src/infra/net/hostname.ts` | Reuse `normalizeHostname()` directly | HIGH |

### Testing

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Vitest | (existing) | Unit + integration tests | Already used throughout; colocated `*.test.ts` pattern | HIGH |
| Existing SSRF test patterns | N/A | Test structure reference | `ssrf.test.ts`, `ssrf.dispatcher.test.ts`, `ssrf.pinning.test.ts` demonstrate the testing approach | HIGH |

## What NOT to Use

| Technology | Why Not |
|------------|---------|
| `dns-blocklist` (npm) | Abandoned; last publish years ago; designed for DNS server use, not HTTP gateway filtering |
| `adblock-rs` / `@aspect-build/rules_js` | Adblock filter parsing; wrong problem domain; massive overhead for simple domain matching |
| `node-adblock` | Browser ad-blocking engine; completely wrong abstraction level |
| `dnsbl` (npm) | DNS-based Blackhole List protocol (DNSBL/RBL); queries external DNS servers for IP reputation; wrong mechanism entirely (we need domain-name filtering, not IP reputation) |
| `pi-hole` style packages | Full DNS server stack; we need a function, not a service |
| Trie/radix tree libraries | Over-engineering; `Set` with suffix walking handles 200K+ domains in sub-microsecond; Trie becomes relevant at 10M+ domains |
| `hosts-file-parser` (npm) | Unnecessary dependency for trivial parsing; also we should use domains-only format instead |
| `lru-cache` for domain lookups | Caching `Set.has()` results adds complexity without benefit; the lookup is already O(1) |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Data structure | `Set<string>` | Trie / radix tree | Set is sufficient up to 500K+ domains; trie adds complexity with no measurable benefit |
| List format | Domains-only `.txt` | Hosts file format | Extra parsing step for no benefit; domains-only is universally available |
| List source | Hagezi Multi Pro | StevenBlack unified | Hagezi is more actively maintained, better categorized, provides domains-only format natively |
| Matching | Suffix walking | Regex patterns | Suffix walking is simpler, faster, and handles subdomain matching correctly |
| Error type | Extend `SsrFBlockedError` | New error class | Consistency with existing SSRF infrastructure; same catch handlers apply |

## Memory Considerations

| List Size | Approximate Memory | Viable? |
|-----------|-------------------|---------|
| 50 domains (spike) | ~5 KB | Trivially yes |
| 50K domains | ~5 MB | Yes, no concern |
| 200K domains | ~20 MB | Yes, acceptable for a gateway process |
| 500K domains | ~50 MB | Yes, but approaching the point where optimization matters |
| 1M+ domains | ~100 MB+ | Consider a more compact data structure (Bloom filter, trie) |

**For the initial implementation:** A hard-coded list of 10-50 domains uses negligible memory. Even full community lists (200K domains) are well within acceptable bounds for a Node.js gateway process.

## Installation

```bash
# No new dependencies required.
# Everything builds on Node.js built-ins and existing OpenClaw infrastructure.
```

## Sources

- Direct analysis of `src/infra/net/ssrf.ts`, `src/infra/net/hostname.ts`, `src/plugin-sdk/ssrf-policy.ts` (HIGH confidence - primary source)
- Training data knowledge of Hagezi, StevenBlack, OISD blocklist ecosystems (MEDIUM confidence - not verified against current state)
- Training data knowledge of npm DNS/blocklist package landscape (LOW-MEDIUM confidence - package ecosystem changes frequently)
- Domain count estimates are approximate and based on training data; verify against current list downloads when implementing remote fetching (LOW confidence on exact numbers)
