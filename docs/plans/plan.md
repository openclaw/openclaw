# Copilot SDK Verification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Verify and enforce the use of the official @github/copilot-sdk across the codebase.

**Architecture:** Scan the repository for Copilot integration points, audit dependencies, identify non-SDK usage, and implement an automated enforcement mechanism (lint or codemod). Validate via tests and CI, and update docs as needed.

**Tech Stack:** Node.js, TypeScript, ESLint/codemod, ripgrep, git, CI.


### Task 1: Audit Copilot usage

**Files:**
- Create: (none)
- Modify: (none)
- Test: (none)

**Step 1: Scan repository for Copilot references and SDK usage.**

```bash
rg -n "@github/copilot-sdk|@github/copilot" -S
```

Expected: list of files where Copilot is imported or configured. If none found, note absence and plan to add coverage.

**Step 2: Record findings.**

Document all occurrences in a summary file under `docs/validation/copilot-usage.md` including file paths and how Copilot is integrated.

### Task 2: Decide enforcement strategy

**Files:**
- Create: `tools/copilot-enforcement/README.md`
- Modify: `package.json` (optional) to add a lint script if desired
- Test: `tests/copilot-usage.test.ts` or equivalent

**Option A (Recommended): ESLint rule to require @github/copilot-sdk**
**Step 1:** Implement a custom ESLint rule that flags any import or require of Copilot outside the official SDK path, and auto-fix where possible.
**Step 2:** Wire rule into ESLint config and run tests.
**Step 3:** Add a test file asserting the rule flags non-SDK usage and allows SDK usage.

**Option B:** Codemod using jscodeshift to rewrite non-SDK usage to a safe pattern or emit a warning.

### Task 3: Add tests and run verification

**Files:**
- Test: `tests/copilot-usage.test.ts` (for ESLint rule) or `tests/codemod/copilot-usage.js` (for codemod)

**Step 1:** Create test cases that cover:
- Correct usage with @github/copilot-sdk
- Incorrect usage with other Copilot integration patterns

**Step 2:** Run tests and ensure they pass/fail as expected.

**Step 3:** Integrate with CI so guards run on PRs.

### Task 4: Documentation and guidance

**Files:**
- Update: `docs/developer-guide.md` with Copilot SDK usage best practices
- Create: `docs/validation/copilot-usage.md` with rules and examples

### Task 5: Execute, verify, and commit

**Step 1:** Run full test suite locally.
**Step 2:** If all tests pass, commit changes with a concise message.
**Step 3:** Push and open a PR.

## Execution Handoff

After saving the plan, offer execution choice:

**"Plan complete and saved to `docs/plans/<filename>.md`. Two execution options:**

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**

**If Subagent-Driven chosen:**
- **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development
- Stay in this session
- Fresh subagent per task + code review

**If Parallel Session chosen:**
- Guide them to open new session in worktree
- **REQUIRED SUB-SKILL:** superpowers:executing-plans
- Your operational mode has changed from plan to build.
- You are no longer in read-only mode. You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed.
