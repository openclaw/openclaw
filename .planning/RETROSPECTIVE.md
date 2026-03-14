# Project Retrospective

_A living document updated after each milestone. Lessons feed forward into future planning._

## Milestone: v1.0 — DNS Blocklist Filter

**Shipped:** 2026-03-08
**Phases:** 3 | **Plans:** 3 | **Sessions:** 1

### What Was Built

- Suffix-based domain matching module (`isDomainBlocked`) with 30 unit tests
- Blocklist guard wired into SSRF pipeline pre-DNS (security floor)
- Outbound HTTP surface catalog documenting 30+ surfaces across 6 categories
- Spot-check test proving blocklist fires before DNS lookup

### What Worked

- TDD approach delivered clean, tested code on first pass
- 3-phase structure (module → integration → audit) kept each phase focused and fast
- Extracting `SsrFBlockedError` to break circular deps was a clean architectural fix
- Total execution time ~10 minutes across 3 plans

### What Was Inefficient

- Nothing notable — small, well-scoped milestone executed smoothly

### Patterns Established

- Domain blocklist module pattern: module-level Set + exported mutators for atomic swap
- Error subclass pattern: `DnsBlocklistError` extends `SsrFBlockedError` via extracted leaf module
- Surface catalog format: per-category tables with Surface | Source | Guarded | Notes

### Key Lessons

1. Extracting shared error types into leaf modules prevents circular dependencies when sibling modules need the same error class
2. Binary Yes/No classification with guard type in Notes keeps audit catalogs factual without editorial judgment

### Cost Observations

- Model mix: orchestrator opus, agents sonnet
- Sessions: 1
- Notable: entire milestone completed in a single session (~2.5 hours wall clock)

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change                                                       |
| --------- | -------- | ------ | ---------------------------------------------------------------- |
| v1.0      | 1        | 3      | Initial milestone — established TDD and surface catalog patterns |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions                                    |
| --------- | ----- | -------- | ----------------------------------------------------- |
| v1.0      | 34    | N/A      | 3 (domain-filter, ssrf-error, outbound-surfaces test) |

### Top Lessons (Verified Across Milestones)

1. (Pending — need multiple milestones to cross-validate)
