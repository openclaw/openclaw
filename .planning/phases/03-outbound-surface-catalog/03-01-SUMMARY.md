---
phase: 03-outbound-surface-catalog
plan: 01
subsystem: infra
tags: [ssrf, dns-blocklist, security-audit, documentation]

requires:
  - phase: 02-ssrf-pipeline-integration
    provides: fetchWithSsrFGuard with DNS blocklist guard wired in
provides:
  - Outbound HTTP surface catalog document
  - Spot-check test proving blocklist coverage through fetch-guard
affects: []

tech-stack:
  added: []
  patterns:
    - "Surface catalog as Mintlify doc with per-category tables"

key-files:
  created:
    - docs/reference/outbound-surfaces.md
    - src/infra/net/outbound-surfaces.test.ts
  modified: []

key-decisions:
  - "Binary Yes/No Guarded column with guard type in Notes"
  - "Agent-controlled URLs annotated distinctly in Notes column"
  - "6 categories: Agent Tools, Channel APIs, Provider APIs, Media Pipeline, Infrastructure, Extensions (Sample)"

patterns-established:
  - "Outbound surface catalog format: Surface | Source | Guarded | Notes per category"

requirements-completed: [TEST-03]

duration: 2min
completed: 2026-03-08
---

# Phase 3 Plan 1: Outbound Surface Catalog Summary

**Outbound HTTP surface catalog with 6 categories and spot-check test proving DnsBlocklistError through fetchWithSsrFGuard**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-08T17:39:10Z
- **Completed:** 2026-03-08T17:41:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Spot-check test proves fetchWithSsrFGuard rejects blocked domains with DnsBlocklistError before DNS resolution
- Catalog documents all gateway outbound HTTP call sites across 6 categories (30+ surfaces)
- Agent-controlled URLs flagged distinctly; binary Yes/No SSRF chokepoint coverage

## Task Commits

Each task was committed atomically:

1. **Task 1: Spot-check test** - `ca9d2ffb2` (test)
2. **Task 2: Outbound HTTP surface catalog** - `8160375a2` (docs)

## Files Created/Modified

- `src/infra/net/outbound-surfaces.test.ts` - Spot-check test proving blocklist works through fetch-guard pipeline
- `docs/reference/outbound-surfaces.md` - Complete outbound HTTP surface catalog with 6 category tables

## Decisions Made

- Binary Yes/No for Guarded column with guard type explanation in Notes
- Agent-controlled URLs annotated with "(agent-controlled URL)" in Notes column
- Signal and iMessage marked No with "No outbound HTTP (local subprocess)" note
- 5 representative extensions sampled (Matrix, MS Teams, Feishu)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- DNS blocklist feature complete across all three phases
- Phase 1: core module, Phase 2: SSRF integration, Phase 3: surface catalog and verification
- TEST-03 requirement satisfied

---

_Phase: 03-outbound-surface-catalog_
_Completed: 2026-03-08_
