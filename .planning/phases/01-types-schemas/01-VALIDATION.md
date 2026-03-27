---
phase: 1
slug: types-schemas
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-26
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                        |
| ---------------------- | ---------------------------- |
| **Framework**          | vitest 3.1.x                 |
| **Config file**        | `vitest.config.ts`           |
| **Quick run command**  | `pnpm test -- src/projects/` |
| **Full suite command** | `pnpm test`                  |
| **Estimated runtime**  | ~15 seconds (scoped)         |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- src/projects/`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type   | Automated Command                       | File Exists | Status     |
| ------- | ---- | ---- | ----------- | ----------- | --------------------------------------- | ----------- | ---------- |
| TBD     | 01   | 1    | PARSE-01    | unit        | `pnpm test -- src/projects/frontmatter` | ❌ W0       | ⬜ pending |
| TBD     | 01   | 1    | PARSE-02    | unit        | `pnpm test -- src/projects/schemas`     | ❌ W0       | ⬜ pending |
| TBD     | 01   | 1    | PARSE-03    | unit        | `pnpm test -- src/projects/frontmatter` | ❌ W0       | ⬜ pending |
| TBD     | 01   | 1    | DATA-03     | unit        | `pnpm test -- src/projects/schemas`     | ❌ W0       | ⬜ pending |
| TBD     | 01   | 1    | DATA-04     | unit        | `pnpm test -- src/projects/schemas`     | ❌ W0       | ⬜ pending |
| TBD     | 01   | 1    | DATA-05     | unit        | `pnpm test -- src/projects/schemas`     | ❌ W0       | ⬜ pending |
| TBD     | 01   | 1    | DATA-07     | unit        | `pnpm test -- src/projects/schemas`     | ❌ W0       | ⬜ pending |
| TBD     | 01   | 1    | DATA-08     | unit        | `pnpm test -- src/projects/schemas`     | ❌ W0       | ⬜ pending |
| TBD     | 01   | 1    | PARSE-04    | integration | `pnpm test -- src/markdown/frontmatter` | ✅          | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] `src/projects/frontmatter.test.ts` — stubs for PARSE-01, PARSE-03
- [ ] `src/projects/schemas.test.ts` — stubs for PARSE-02, DATA-03, DATA-04, DATA-05, DATA-07, DATA-08
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
