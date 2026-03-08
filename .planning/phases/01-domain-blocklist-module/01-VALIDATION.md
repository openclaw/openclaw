---
phase: 1
slug: domain-blocklist-module
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (project version) |
| **Config file** | Exists (project-level vitest config) |
| **Quick run command** | `pnpm test src/infra/net/domain-filter.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test src/infra/net/domain-filter.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | MATCH-01 | unit | `pnpm test src/infra/net/domain-filter.test.ts` | ❌ W0 | ⬜ pending |
| 1-01-02 | 01 | 1 | MATCH-02 | unit | `pnpm test src/infra/net/domain-filter.test.ts` | ❌ W0 | ⬜ pending |
| 1-01-03 | 01 | 1 | MATCH-03 | unit | `pnpm test src/infra/net/domain-filter.test.ts` | ❌ W0 | ⬜ pending |
| 1-01-04 | 01 | 1 | LIST-01 | unit | `pnpm test src/infra/net/domain-filter.test.ts` | ❌ W0 | ⬜ pending |
| 1-01-05 | 01 | 1 | LIST-02 | unit | `pnpm test src/infra/net/domain-filter.test.ts` | ❌ W0 | ⬜ pending |
| 1-01-06 | 01 | 1 | OBS-01 | unit | `pnpm test src/infra/net/domain-filter.test.ts` | ❌ W0 | ⬜ pending |
| 1-01-07 | 01 | 1 | TEST-01 | unit | `pnpm test src/infra/net/domain-filter.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/infra/net/domain-filter.test.ts` — stubs for MATCH-01, MATCH-02, MATCH-03, LIST-01, LIST-02, OBS-01, TEST-01
- No framework install needed — Vitest already configured
- No shared fixtures needed — test arrays are self-contained (following ssrf.test.ts pattern)

*Existing infrastructure covers framework requirements.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
