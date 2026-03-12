# Set Thinking Level Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `set_thinking_level` agent tool that can change thinking for the rest of the current run or persist a session default, while preserving provider-aware best-effort adaptive behavior.

**Architecture:** Introduce a shared requested/effective thinking resolver, thread a mutable run-local thinking override through the embedded runner and tool layer, then add a new built-in tool that uses existing session validation for persistence and dynamic per-request thinking resolution for immediate effect.

**Tech Stack:** TypeScript, Vitest, TypeBox, OpenClaw embedded Pi runner, session store helpers

---

### Task 1: Shared thinking resolution

**Files:**

- Modify: `src/auto-reply/thinking.ts`
- Test: `src/auto-reply/thinking.test.ts`

**Step 1: Write the failing tests**

Add tests for a new shared resolver that:

- preserves `adaptive` as requested intent
- maps `adaptive` to native adaptive when supported
- downgrades `adaptive` best-effort for non-native providers
- maps binary-provider adaptive behavior to enabled/on semantics
- reports unsupported reasoning clearly

**Step 2: Run test to verify it fails**

Run: `pnpm test src/auto-reply/thinking.test.ts`

Expected: FAIL because the resolver does not exist yet.

**Step 3: Write minimal implementation**

Add the smallest shared helper(s) needed to compute:

- requested level
- effective provider behavior
- optional downgrade reason text

Keep existing normalization helpers intact and build on them.

**Step 4: Run test to verify it passes**

Run: `pnpm test src/auto-reply/thinking.test.ts`

Expected: PASS

### Task 2: Dynamic run-local thinking state

**Files:**

- Modify: `src/agents/pi-embedded-runner/run/attempt.ts`
- Modify: `src/agents/pi-tools.ts`
- Modify: `src/agents/openclaw-tools.ts`
- Modify: `src/agents/pi-embedded-runner/extra-params.ts`
- Test: `src/agents/pi-embedded-runner-extraparams.test.ts`

**Step 1: Write the failing tests**

Add tests proving that a model-call path can read thinking dynamically from mutable run-local state and that later calls in the same run can observe an updated override.

**Step 2: Run test to verify it fails**

Run: `pnpm test src/agents/pi-embedded-runner-extraparams.test.ts`

Expected: FAIL because thinking is currently captured statically.

**Step 3: Write minimal implementation**

Thread a mutable run-local thinking reference through the runner and tool creation path, then update the extra-params/provider wrapper path to consult the live resolved level before each request.

**Step 4: Run test to verify it passes**

Run: `pnpm test src/agents/pi-embedded-runner-extraparams.test.ts`

Expected: PASS

### Task 3: `set_thinking_level` tool

**Files:**

- Create: `src/agents/tools/set-thinking-level-tool.ts`
- Modify: `src/agents/openclaw-tools.ts`
- Test: `src/agents/openclaw-tools.set-thinking-level.test.ts`

**Step 1: Write the failing tests**

Add tests covering:

- tool registration
- `turn` scope updates run-local state only
- `session` scope persists via session store and updates current run
- clear/reset behavior
- result shape includes requested/effective/scope/persisted fields
- adaptive downgrade explanation is returned when applicable

**Step 2: Run test to verify it fails**

Run: `pnpm test src/agents/openclaw-tools.set-thinking-level.test.ts`

Expected: FAIL because the tool does not exist yet.

**Step 3: Write minimal implementation**

Implement the tool with TypeBox schema, parameter parsing, session-store persistence via existing helpers, and run-local immediate application.

**Step 4: Run test to verify it passes**

Run: `pnpm test src/agents/openclaw-tools.set-thinking-level.test.ts`

Expected: PASS

### Task 4: Focused regression verification

**Files:**

- Modify if needed: any files above

**Step 1: Run focused test suite**

Run: `pnpm test src/auto-reply/thinking.test.ts src/agents/pi-embedded-runner-extraparams.test.ts src/agents/openclaw-tools.set-thinking-level.test.ts`

Expected: PASS

**Step 2: Run targeted quality checks if touched files require them**

Run: `pnpm test src/agents/openclaw-tools.sessions.test.ts src/gateway/sessions-patch.test.ts`

Expected: PASS

**Step 3: Refine if failures reveal gaps**

Fix only failures related to this feature and re-run the same commands.

Plan complete and saved to `docs/plans/2026-03-12-set-thinking-level.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
