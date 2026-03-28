---
phase: 5
slug: context-injection
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-27
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| **Framework**          | vitest                                                                                  |
| **Config file**        | `vitest.config.ts`                                                                      |
| **Quick run command**  | `pnpm test -- src/projects/capability-matcher.test.ts`                                  |
| **Full suite command** | `pnpm test -- src/projects/capability-matcher.test.ts src/agents/identity-file.test.ts` |
| **Estimated runtime**  | ~8 seconds                                                                              |

---

## Sampling Rate

- **After every task commit:** Run quick command
- **After every plan wave:** Run full suite command
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID  | Plan | Wave | Requirement               | Test Type   | Automated Command                                      | File Exists | Status     |
| -------- | ---- | ---- | ------------------------- | ----------- | ------------------------------------------------------ | ----------- | ---------- |
| 05-01-01 | 01   | 1    | AGNT-04                   | unit        | `pnpm test -- src/projects/capability-matcher.test.ts` | ❌ W0       | ⬜ pending |
| 05-01-02 | 01   | 1    | AGNT-04                   | unit        | `pnpm test -- src/agents/identity-file.test.ts`        | ✅ existing | ⬜ pending |
| 05-02-01 | 02   | 2    | AGNT-01, AGNT-02, AGNT-03 | integration | `pnpm test -- src/agents/bootstrap-files.test.ts`      | ✅ existing | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] `src/projects/capability-matcher.test.ts` — stubs for AGNT-04

_Existing infrastructure (vitest, identity-file tests) covers remaining needs._

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
