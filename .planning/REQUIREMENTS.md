# Requirements: OpenClaw DNS Blocklist Filter

**Defined:** 2026-03-08
**Core Value:** Outbound HTTP requests from the gateway must be checked against DNS blocklists before any network call, preventing AI agents from contacting known-malicious domains.

## v1 Requirements

### Domain Matching

- [ ] **MATCH-01**: Exact domain matching — `malware.test` blocks `malware.test`
- [ ] **MATCH-02**: Subdomain matching — `sub.malware.test` blocked by `malware.test` entry
- [ ] **MATCH-03**: Hostname normalization — trailing dots, case insensitivity, whitespace trimming via existing `normalizeHostname()`

### SSRF Integration

- [ ] **SSRF-01**: Blocklist check wired into `resolvePinnedHostnameWithPolicy()` Phase 1 (pre-DNS)

### Blocklist Management

- [ ] **LIST-01**: Hard-coded starter blocklist with test domains (`malware.test`, `example.bad`)
- [ ] **LIST-02**: Atomic `Set<string>` data structure for thread-safe lookups

### Observability

- [ ] **OBS-01**: Clear error message identifying the blocked domain name

### Testing

- [ ] **TEST-01**: Unit tests for `isDomainBlocked()` — exact match, subdomain, non-blocked, edge cases
- [ ] **TEST-02**: Integration test proving blocked hostname causes error through SSRF pipeline
- [ ] **TEST-03**: Catalog of all outbound HTTP paths documented (hook one, note others)

## v2 Requirements

### SSRF Integration

- **SSRF-02**: Extend `SsrFBlockedError` with blocklist-specific subclass
- **SSRF-03**: Policy precedence — blocklist as security floor not bypassable via allowlist

### Blocklist Management

- **LIST-03**: Config-driven custom domain lists (`security.dnsBlocklists` schema)
- **LIST-04**: Remote list fetching from URLs (Hagezi, OISD, StevenBlack)
- **LIST-05**: Periodic refresh with stale-while-revalidate and atomic Set swap

### Observability

- **OBS-02**: Typed deterministic error for programmatic handling
- **OBS-03**: Logging/metrics for blocked request counts
- **OBS-04**: Config toggle for blocking vs. warn-only mode

### Policy

- **POL-01**: Per-agent blocklist policies
- **POL-02**: Per-tool blocklist overrides

## Out of Scope

| Feature | Reason |
|---------|--------|
| DNS sinkhole / DNS server | Wrong abstraction level — this is application-layer filtering, not network-level |
| Regex-based domain matching | Unnecessary complexity; suffix matching covers all standard blocklist use cases |
| IP address blocklists | Already handled by existing SSRF infrastructure (`isPrivateIpAddress`) |
| Standalone library extraction | Possible future project, not in scope for this PR |
| IDN/punycode normalization | Deferred; document as known gap |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| MATCH-01 | Phase 1 | Pending |
| MATCH-02 | Phase 1 | Pending |
| MATCH-03 | Phase 1 | Pending |
| SSRF-01 | Phase 2 | Pending |
| LIST-01 | Phase 1 | Pending |
| LIST-02 | Phase 1 | Pending |
| OBS-01 | Phase 1 | Pending |
| TEST-01 | Phase 1 | Pending |
| TEST-02 | Phase 2 | Pending |
| TEST-03 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 10 total
- Mapped to phases: 10
- Unmapped: 0

---
*Requirements defined: 2026-03-08*
*Last updated: 2026-03-08 after roadmap creation*
