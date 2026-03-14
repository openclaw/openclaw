# Milestones

## v1.0 DNS Blocklist Filter (Shipped: 2026-03-08)

**Phases completed:** 3 phases, 3 plans, 0 tasks

**Key accomplishments:**

- Suffix-based domain matching module (`isDomainBlocked`) with 30 TDD-driven unit tests
- Blocklist guard wired into SSRF pipeline pre-DNS — security floor not bypassable by allowlist
- Extracted `SsrFBlockedError` into `ssrf-error.ts` to break circular dependency
- Outbound HTTP surface catalog documenting 30+ surfaces across 6 categories
- Spot-check test proving blocklist fires before DNS lookup through fetch-guard path

**Stats:**

- Timeline: 2026-03-08 (single session)
- Files: 24 changed, 2,358 insertions, 88 deletions
- Execution time: ~10 minutes across 3 plans

---
