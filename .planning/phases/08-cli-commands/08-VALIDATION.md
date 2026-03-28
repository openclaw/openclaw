---
phase: 08
slug: cli-commands
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-28
---

# Phase 08 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (forks pool) |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `pnpm test -- src/commands/projects.{name}.test.ts` |
| **Full suite command** | `pnpm test -- src/commands/projects` |
| **Estimated runtime** | ~20 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- src/commands/projects.{touched}.test.ts`
- **After every plan wave:** Run `pnpm test -- src/commands/projects`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 25 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 01 | 1 | CLI-01 | unit | `pnpm test -- src/commands/projects.create.test.ts` | ❌ W0 | ⬜ pending |
| 08-01-02 | 01 | 1 | CLI-02 | unit | `pnpm test -- src/commands/projects.list.test.ts` | ❌ W0 | ⬜ pending |
| 08-02-01 | 02 | 1 | CLI-03 | unit | `pnpm test -- src/commands/projects.status.test.ts` | ❌ W0 | ⬜ pending |
| 08-02-02 | 02 | 1 | CLI-04, CLI-05 | unit | `pnpm test -- src/commands/projects.reindex.test.ts src/commands/projects.validate.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements. Vitest and test helpers already available.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Interactive prompts render correctly | CLI-01 | @clack/prompts visual rendering | Run `openclaw projects create` in terminal, verify prompts appear |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 25s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
