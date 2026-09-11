# Roadmap: OpenClaw Talk/Queue Fix Initiative

**Created:** 2026-09-10
**Project:** OpenClaw Platform
**Goal:** Fix queued consult empty-completion issue, plumb `retiredFollowupRunIds`, and restore type-check/build contract.

## Phase Overview

| Phase | Name               | Focus                                  | Requirements                                                       |
| ----- | ------------------ | -------------------------------------- | ------------------------------------------------------------------ |
| 1     | Fix Implementation | Core talk/queue fix, type safety, CI   | TALK-01 through TALK-06, TYPE-01 through TYPE-03, CI-01 → complete |
| 2     | Verification       | Run full test suite, type checks, lint | All requirements verified ✅                                       |
| 3     | Landing            | Final review, commit staging, PR ready | All checks green ✅ ✇ committed                                    |

## Phase 1: Fix Implementation

**Goal:** Land the core fix and supporting changes on the current branch.

**Success criteria:**

- Queued consult with empty completion does not lose follow-up runId ✓
- Unmatched-event buffer is bounded ✓
- `retiredFollowupRunIds` plumbed through full lifecycle chain ✓
- All existing tests pass ✓
- New regression tests cover the fixed paths ✓

**Deliverables:**

- Production code changes (if not already done)
- Updated test mocks and helpers
- Import cycle fixes
- Type-check contract restored

## Phase 2: Verification

**Goal:** Verify all changes with appropriate proof.

**Success criteria:**

- `pnpm check:changed` passes
- `pnpm typecheck` passes with strict types
- Focused tests pass: all talk/queue related test files
- Full test suite run for affected subsystems

**Deliverables:**

- VERIFICATION.md report

**Plans:**

- [ ] 02-01-PLAN.md — Run check:changed and tsgo typecheck lanes
- [ ] 02-02-PLAN.md — Run focused gateway server tests
- [ ] 02-03-PLAN.md — Run ratchets, full subsystem tests, write VERIFICATION.md

## Phase 3: Landing

**Goal:** Prepare for landing the branch.

**Deliverables:**

- Final commit staging
- PR summary
- Clean working directory

---

_Last updated: 2026-09-10 after initial roadmap creation_
