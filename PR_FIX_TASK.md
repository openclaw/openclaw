# Task: Fix PR #48888 and rebase onto main

## Context

This is PR https://github.com/openclaw/openclaw/pull/48888
Branch: fix/repair-tool-use-error-aborted
Target: main

The PR fixes `repairToolUseResultPairing()` to strip orphaned tool_use blocks from
error/aborted assistant messages instead of passing them through unchanged.
The core idea is correct. There are 4 bugs to fix, plus a rebase conflict to resolve.

## Files to modify

- `src/agents/session-transcript-repair.ts`
- `src/agents/session-transcript-repair.test.ts`

## The 4 bugs (from Greptile review)

### Bug 1: Type-incorrect `added` push

In session-transcript-repair.ts, find where strings like `"stripped-error-<id>"`
are pushed into the `added` array. The `added` array is typed as
`Array<Extract<AgentMessage, { role: "toolResult" }>>`.
Fix: just set `changed = true` instead of pushing to `added`.

### Bug 2: `result.changed` doesn't exist on return type

In session-transcript-repair.test.ts, find `expect(result.changed).toBe(true)`.
`ToolUseRepairReport` has no `changed` field — only `messages`, `added`,
`droppedDuplicateCount`, `droppedOrphanCount`, and `moved`.
Fix: replace `expect(result.changed).toBe(true)` with
`expect(result.moved).toBeTruthy()` or check that `result.messages` changed.
Actually the best fix: add `changed: boolean` to `ToolUseRepairReport` and return it.

### Bug 3: `functionCall` blocks not stripped

In session-transcript-repair.ts, find the filter that strips tool blocks.
It likely says `b.type !== "toolCall" && b.type !== "toolUse"`.
Fix: also add `&& b.type !== "functionCall"` to the filter.

### Bug 4: Existing test broken by new `added` push

In session-transcript-repair.test.ts, find a test that expects
`result.added.toHaveLength(0)` after an aborted message.
Fix: update the assertion after fixing Bug 1 (since we won't push to `added` anymore,
the original assertion of toHaveLength(0) may still be correct — verify).

## Rebase approach

The current branch (fix/repair-tool-use-error-aborted) has a conflict when
cherry-picking onto main. The conflict is in session-transcript-repair.ts around
line 496 — the PR removes the old `stopReason === "error" || stopReason === "aborted"`
skip block, but main has updated that same area.

Steps:

1. First understand both the PR diff and the current main version of the file
2. Apply the PR's logic (strip tool_use from error/aborted messages) on top of main
3. Fix the 4 bugs above
4. Run: pnpm install && pnpm check && pnpm test -- --testPathPattern session-transcript-repair
5. If tests pass, commit with message: "fix(repair): strip tool_use blocks from error/aborted messages (fixes #48354)"

## Important

- Work on branch fix-48888-v2 (already created, currently pointing to main HEAD)
- Do NOT push — just get to a clean commit with passing tests
- Report which bugs you fixed and test results

When completely finished, run:
openclaw system event --text "PR #48888 fix complete: ready to review and push" --mode now
