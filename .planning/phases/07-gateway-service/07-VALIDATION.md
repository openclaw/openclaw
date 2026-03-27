---
phase: 7
slug: gateway-service
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-27
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest with V8 coverage |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `pnpm test -- src/gateway/server-projects.test.ts src/gateway/server-methods/projects.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds (scoped), ~120 seconds (full) |

---

## Sampling Rate

- **After every task commit:** Run scoped test command
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 07-01-01 | 01 | 1 | GATE-01 | unit | `pnpm test -- src/gateway/server-projects.test.ts` | ❌ W0 | ⬜ pending |
| 07-01-02 | 01 | 1 | GATE-03 | unit | `pnpm test -- src/gateway/server-projects.test.ts` | ❌ W0 | ⬜ pending |
| 07-02-01 | 02 | 1 | GATE-02 | unit | `pnpm test -- src/gateway/server-methods/projects.test.ts` | ❌ W0 | ⬜ pending |
| 07-02-02 | 02 | 1 | GATE-04 | integration | `pnpm test -- src/gateway/method-scopes.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/gateway/server-projects.test.ts` — stubs for GATE-01, GATE-03
- [ ] `src/gateway/server-methods/projects.test.ts` — stubs for GATE-02
