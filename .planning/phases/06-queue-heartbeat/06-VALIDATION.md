---
phase: 06
slug: queue-heartbeat
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-27
---

# Phase 06 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (V8 coverage, forks pool) |
| **Config file** | vitest.config.ts (existing) |
| **Quick run command** | `pnpm test -- src/projects/heartbeat-scanner.test.ts` |
| **Full suite command** | `pnpm test -- src/projects/heartbeat-scanner.test.ts src/projects/checkpoint.test.ts` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- src/projects/heartbeat-scanner.test.ts`
- **After every plan wave:** Run `pnpm test -- src/projects/heartbeat-scanner.test.ts src/projects/checkpoint.test.ts`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | AGNT-07 | unit | `pnpm test -- src/projects/checkpoint.test.ts` | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 1 | AGNT-05, AGNT-06, AGNT-08, AGNT-09 | unit | `pnpm test -- src/projects/heartbeat-scanner.test.ts` | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 2 | AGNT-05 | integration | `pnpm test -- src/projects/heartbeat-scanner.test.ts -t "integration"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending / ✅ green / ❌ red / ⚠️ flaky*

---

## Wave 0 Requirements

- Existing test infrastructure covers all phase requirements (Vitest, forks pool, V8 coverage)
- No additional framework setup needed

*Existing infrastructure covers all phase requirements.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-03-27
