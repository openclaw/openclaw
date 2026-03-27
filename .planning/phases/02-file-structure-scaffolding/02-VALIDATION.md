---
phase: 2
slug: file-structure-scaffolding
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-27
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                |
| ---------------------- | ------------------------------------ |
| **Framework**          | vitest 3.1.x                         |
| **Config file**        | `vitest.config.ts`                   |
| **Quick run command**  | `pnpm test -- src/projects/scaffold` |
| **Full suite command** | `pnpm test -- src/projects/`         |
| **Estimated runtime**  | ~15 seconds (scoped)                 |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- src/projects/scaffold`
- **After every plan wave:** Run `pnpm test -- src/projects/`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command                    | File Exists | Status     |
| ------- | ---- | ---- | ----------- | --------- | ------------------------------------ | ----------- | ---------- |
| TBD     | 01   | 1    | DATA-01     | unit      | `pnpm test -- src/projects/scaffold` | ❌ W0       | ⬜ pending |
| TBD     | 01   | 1    | DATA-02     | unit      | `pnpm test -- src/projects/scaffold` | ❌ W0       | ⬜ pending |
| TBD     | 01   | 1    | DATA-06     | unit      | `pnpm test -- src/projects/scaffold` | ❌ W0       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] `src/projects/scaffold.test.ts` — stubs for DATA-01, DATA-02, DATA-06
- [ ] No framework install needed — vitest already configured

_Existing infrastructure covers framework requirements._

---

## Manual-Only Verifications

_All phase behaviors have automated verification._

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
