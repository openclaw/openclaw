---
phase: 4
slug: concurrency
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-27
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                             |
| ---------------------- | ------------------------------------------------- |
| **Framework**          | vitest                                            |
| **Config file**        | `vitest.config.ts`                                |
| **Quick run command**  | `pnpm test -- src/projects/queue-manager.test.ts` |
| **Full suite command** | `pnpm test -- src/projects/queue-manager.test.ts` |
| **Estimated runtime**  | ~5 seconds                                        |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- src/projects/queue-manager.test.ts`
- **After every plan wave:** Run `pnpm test -- src/projects/queue-manager.test.ts`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID  | Plan | Wave | Requirement               | Test Type          | Automated Command                                 | File Exists | Status     |
| -------- | ---- | ---- | ------------------------- | ------------------ | ------------------------------------------------- | ----------- | ---------- |
| 04-01-01 | 01   | 1    | CONC-01, CONC-02, CONC-03 | unit + integration | `pnpm test -- src/projects/queue-manager.test.ts` | ❌ W0       | ⬜ pending |
| 04-01-02 | 01   | 1    | CONC-04                   | unit               | `pnpm test -- src/projects/queue-manager.test.ts` | ❌ W0       | ⬜ pending |
| 04-01-03 | 01   | 1    | CONC-05                   | unit               | `pnpm test -- src/projects/queue-manager.test.ts` | ❌ W0       | ⬜ pending |
| 04-02-01 | 02   | 1    | CONC-01                   | concurrent         | `pnpm test -- src/projects/queue-manager.test.ts` | ❌ W0       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] `src/projects/queue-manager.test.ts` — stubs for CONC-01 through CONC-05

_Existing infrastructure (vitest, file-lock test helpers) covers framework needs._

---

## Manual-Only Verifications

_All phase behaviors have automated verification._

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
