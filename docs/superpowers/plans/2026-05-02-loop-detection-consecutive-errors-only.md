# Loop Detection Consecutive Errors Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a run-scoped consecutive tool-error detector without introducing the rejected per-turn counter design.

**Architecture:** Extend the existing loop-detection history analysis with one new thresholded tail check over run-scoped outcomes, then prove it through both pure detector tests and the real before-tool-call hook path. Keep the rest of the loop-detection model unchanged.

**Tech Stack:** TypeScript, Vitest, OpenClaw loop-detection runtime, docs/changelog markdown

---

## Task 1: Add the detector config and runtime logic

**Files:**

- Modify: `src/agents/tool-loop-detection.ts`
- Modify: `src/config/types.tools.ts`
- Modify: `src/config/zod-schema.agent-runtime.ts`

- [ ] **Step 1: Add the failing config expectations**

Confirm the codebase has no `consecutiveErrorThreshold` support in the current branch, then define the intended default and typing surface in the touched files.

- [ ] **Step 2: Implement the minimal config surface**

Add `consecutiveErrorThreshold?: number` to the type and schema, plus a default constant and resolved config field in `tool-loop-detection.ts`.

- [ ] **Step 3: Implement the detector**

Add a helper that counts the current run-scoped trailing streak of error outcomes, then emit a critical `consecutive_errors` result once the threshold is reached.

- [ ] **Step 4: Keep non-goals out**

Do not add any per-turn or session-level counters, and do not edit `src/logging/diagnostic-session-state.ts`.

## Task 2: Lock behavior with tests

**Files:**

- Modify: `src/agents/tool-loop-detection.test.ts`
- Modify: `src/agents/pi-tools.before-tool-call.e2e.test.ts`

- [ ] **Step 1: Add detector unit tests**

Cover disabled behavior, below-threshold behavior, threshold hit, success breaking the streak, and default threshold behavior.

- [ ] **Step 2: Add hook-level run-scope tests**

Add a test that proves failures from `run-1` do not block a fresh `run-2`, and a same-run test that proves the hook blocks once the threshold is reached.

- [ ] **Step 3: Run targeted tests**

Run: `pnpm test src/agents/tool-loop-detection.test.ts src/agents/pi-tools.before-tool-call.e2e.test.ts`

Expected: PASS

## Task 3: Update docs and release note

**Files:**

- Modify: `docs/tools/loop-detection.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update docs**

Document `consecutiveErrorThreshold` and note that run-scoped history already isolates fresh runs when `runId` exists.

- [ ] **Step 2: Add changelog entry**

Add one Unreleased fix entry describing the new consecutive cross-tool error guard with required attribution formatting.

- [ ] **Step 3: Run targeted format/doc sanity**

Run: `pnpm exec oxfmt --check --threads=1 docs/tools/loop-detection.md CHANGELOG.md src/agents/tool-loop-detection.ts src/agents/tool-loop-detection.test.ts src/agents/pi-tools.before-tool-call.e2e.test.ts src/config/types.tools.ts src/config/zod-schema.agent-runtime.ts`

Expected: PASS

## Task 4: Build, redeploy, and manual verification

**Files:**

- No source changes expected unless verification exposes a bug

- [ ] **Step 1: Build the touched runtime**

Run: `pnpm build`

Expected: PASS

- [ ] **Step 2: Redeploy local OpenClaw**

Use the managed local path appropriate to this repo, preferring `openclaw gateway restart` or the documented gateway watch/restart workflow.

- [ ] **Step 3: Real-machine smoke**

Verify the local gateway comes back cleanly and the runtime is healthy. If feasible, run a focused manual reproduction or scripted smoke that exercises the consecutive-error guard path.

- [ ] **Step 4: Record evidence**

Capture the exact commands and the observed result for later PR/issue drafting.

## Task 5: Rewrite local issue/PR drafts

**Files:**

- Modify: `/Users/shockang/Library/Mobile Documents/iCloud~md~obsidian/Documents/AI/github/pr-001-control-ui-browser-white-screen.md`
- Modify: `/Users/shockang/Library/Mobile Documents/iCloud~md~obsidian/Documents/AI/github/pr-002-tool-loop-consecutive-errors-detector.md`
- Modify: `/Users/shockang/Library/Mobile Documents/iCloud~md~obsidian/Documents/AI/github/pr-003-test-lint-and-type-fixes.md`

- [ ] **Step 1: De-scope PR-001**

Rewrite it as a local note or archived draft that references the already-fixed upstream threads instead of proposing the polyfill implementation.

- [ ] **Step 2: Narrow PR-002**

Rewrite it around `consecutive_errors` only, with the final validated file list, tests, and manual verification evidence.

- [ ] **Step 3: Reframe PR-003**

Mark it as non-upstreamable standalone cleanup unless a real failing gate justifies piggybacking it later.

## Task 6: Commit

**Files:**

- Stage only the intended docs and source changes

- [ ] **Step 1: Review diff**

Run: `git diff --stat` and `git diff -- <targeted files>`

- [ ] **Step 2: Commit with repo protocol**

Use `scripts/committer` with a Lore-style message that explains the narrowed scope and what was intentionally excluded.
