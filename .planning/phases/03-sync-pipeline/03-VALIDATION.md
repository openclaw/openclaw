---
phase: 03
slug: sync-pipeline
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-03-27
---

# Phase 03 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                        |
| ---------------------- | ---------------------------- |
| **Framework**          | vitest                       |
| **Config file**        | vitest.config.ts (existing)  |
| **Quick run command**  | `pnpm test -- src/projects/` |
| **Full suite command** | `pnpm test -- src/projects/` |
| **Estimated runtime**  | ~20 seconds                  |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- src/projects/`
- **After every plan wave:** Run `pnpm test -- src/projects/`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID  | Plan | Wave | Requirement                                 | Test Type   | Automated Command                           | File Exists | Status     |
| -------- | ---- | ---- | ------------------------------------------- | ----------- | ------------------------------------------- | ----------- | ---------- |
| 03-01-01 | 01   | 1    | SYNC-04, SYNC-05                            | unit        | `pnpm test -- src/projects/index-generator` | ❌ W0       | ⬜ pending |
| 03-02-01 | 02   | 1    | SYNC-01, SYNC-02, SYNC-03, SYNC-06, SYNC-07 | integration | `pnpm test -- src/projects/sync-service`    | ❌ W0       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] `src/projects/index-generator.test.ts` — stubs for SYNC-04, SYNC-05
- [ ] `src/projects/sync-service.test.ts` — stubs for SYNC-01, SYNC-02, SYNC-03, SYNC-06, SYNC-07

_Existing test infrastructure (vitest, temp-home, tracked-temp-dirs) covers framework needs._

---

## Manual-Only Verifications

| Behavior                                   | Requirement | Why Manual                           | Test Instructions                           |
| ------------------------------------------ | ----------- | ------------------------------------ | ------------------------------------------- |
| ~500ms latency from save to .index/ update | SYNC-01     | Timing sensitive, may be flaky in CI | Save a file, measure time to .index/ update |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 20s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
