---
phase: 3
slug: outbound-surface-catalog
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                               |
| ---------------------- | --------------------------------------------------- |
| **Framework**          | Vitest (project standard)                           |
| **Config file**        | `vitest.config.ts` (root)                           |
| **Quick run command**  | `pnpm test src/infra/net/outbound-surfaces.test.ts` |
| **Full suite command** | `pnpm test`                                         |
| **Estimated runtime**  | ~5 seconds                                          |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test src/infra/net/outbound-surfaces.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID  | Plan | Wave | Requirement | Test Type | Automated Command                                   | File Exists | Status     |
| -------- | ---- | ---- | ----------- | --------- | --------------------------------------------------- | ----------- | ---------- |
| 03-01-01 | 01   | 1    | TEST-03     | unit      | `pnpm test src/infra/net/outbound-surfaces.test.ts` | ❌ W0       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] `src/infra/net/outbound-surfaces.test.ts` — spot-check test for TEST-03
- [ ] `docs/reference/outbound-surfaces.md` — catalog document

_Existing infrastructure covers test framework requirements._

---

## Manual-Only Verifications

| Behavior             | Requirement | Why Manual                                  | Test Instructions                                                        |
| -------------------- | ----------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| Catalog completeness | TEST-03     | Requires human review of all outbound paths | Review `docs/reference/outbound-surfaces.md` tables for missing surfaces |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
