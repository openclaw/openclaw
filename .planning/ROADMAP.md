# Roadmap: OpenClaw DNS Blocklist Filter

## Overview

Build a DNS blocklist filter that blocks outbound requests to known-malicious domains by extending the existing SSRF infrastructure. Phase 1 builds the standalone matching module with unit tests, Phase 2 wires it into the SSRF pipeline and proves end-to-end blocking, and Phase 3 catalogs all outbound HTTP surfaces to document coverage and gaps.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Domain Blocklist Module** - Standalone `isDomainBlocked()` with matching logic, data structure, error message, and unit tests
- [ ] **Phase 2: SSRF Pipeline Integration** - Wire blocklist into `resolvePinnedHostnameWithPolicy()` Phase 1 and prove end-to-end blocking
- [ ] **Phase 3: Outbound Surface Catalog** - Map all gateway outbound HTTP paths, verify chokepoint coverage, document gaps

## Phase Details

### Phase 1: Domain Blocklist Module

**Goal**: A tested `isDomainBlocked()` function exists that correctly identifies blocked domains using suffix-based matching against an atomic Set
**Depends on**: Nothing (first phase)
**Requirements**: MATCH-01, MATCH-02, MATCH-03, LIST-01, LIST-02, OBS-01, TEST-01
**Success Criteria** (what must be TRUE):

1. Calling `isDomainBlocked("malware.test")` returns true for an exact blocklist entry
2. Calling `isDomainBlocked("sub.malware.test")` returns true when `malware.test` is in the blocklist
3. Domains not in the blocklist return false (no false positives)
4. The blocked-domain error message includes the specific domain name that was blocked
5. Unit tests pass covering exact match, subdomain match, non-blocked domains, and normalization edge cases (trailing dots, case, whitespace)
   **Plans**: 1 plan

Plans:

- [x] 01-01-PLAN.md -- TDD: domain-filter module with isDomainBlocked, Set management, DnsBlocklistError, and unit tests

### Phase 2: SSRF Pipeline Integration

**Goal**: Outbound HTTP requests to blocked domains are rejected before any DNS resolution or network call occurs
**Depends on**: Phase 1
**Requirements**: SSRF-01, TEST-02
**Success Criteria** (what must be TRUE):

1. A request to a blocked domain through `resolvePinnedHostnameWithPolicy()` throws a blocklist error before DNS resolution
2. An integration test proves that a blocked hostname causes a deterministic error through the SSRF pipeline
3. Non-blocked domains continue to resolve and connect normally (no regression)
   **Plans**: 1 plan

Plans:

- [ ] 02-01-PLAN.md -- Wire blocklist guard into resolvePinnedHostnameWithPolicy and add integration tests

### Phase 3: Outbound Surface Catalog

**Goal**: All gateway outbound HTTP paths are documented with their blocklist coverage status
**Depends on**: Phase 2
**Requirements**: TEST-03
**Success Criteria** (what must be TRUE):

1. A catalog exists listing all outbound HTTP paths in the gateway (tools, channels, providers, media, plugins)
2. Each path is annotated with whether it flows through the SSRF chokepoint (protected) or not (gap)
3. At least one path is confirmed protected by the blocklist via the SSRF integration from Phase 2
   **Plans**: TBD

Plans:

- [ ] 03-01: Catalog outbound HTTP surfaces and document coverage

## Progress

| Phase                        | Plans Complete | Status      | Completed  |
| ---------------------------- | -------------- | ----------- | ---------- |
| 1. Domain Blocklist Module   | 1/1            | Complete    | 2026-03-08 |
| 2. SSRF Pipeline Integration | 0/1            | Not started | -          |
| 3. Outbound Surface Catalog  | 0/1            | Not started | -          |
