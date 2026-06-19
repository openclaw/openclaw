# Audit: Contamination Cleanup — `fix/line-86012` Branch

**Generated:** Fri 2026-06-19 10:54 GMT+8  
**Branch:** `fix/line-86012` (HEAD `ff76033e7e`)  
**Base:** `upstream/main`  
**PR #94680** already exists (branch → `openclaw/openclaw`)

---

## Executive Summary

`fix/line-86012` contains **12 commits** (8 for #86012, 4 for #94626). Two #94626 commits are **contaminated** — they modify LINE extension files (`reply-chunks.test.ts`, `retry.test.ts`) that belong to #86012. There is **zero code dependency** between the two issues (no shared imports, no protocol coupling), so they can be safely separated.

A **clean #94626 branch** (`fix/line-94626-status`, base `2c499756ad`) already exists locally with 4 commits that correctly exclude LINE file changes from Phase 2.

---

## 1. Commit Inventory

### #86012 Commits (LINE message loss — 8 commits)

| #   | Hash         | Message                                                                                 | Scope                                                        |
| --- | ------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | `da3d902d9d` | fix(line): pass onReplyError to sendLineReplyChunks                                     | reply-chunks.ts, auto-reply-delivery.ts                      |
| 2   | `19096dd690` | fix(line): local push counter, pushMessageLine errorContext, startup quota log (#86012) | send.ts, send.test.ts, monitor.ts, monitor.lifecycle.test.ts |
| 3   | `e40714cde1` | fix(line): retry wrapper, batch push fallback, retry key (#86012)                       | retry.ts, retry.test.ts, reply-chunks.ts, send.ts            |
| 4   | `d7906c5fdf` | test(line): fix test infrastructure for retry key, quota mock, etc (#86012)             | retry.test.ts, send.test.ts, monitor.lifecycle.test.ts       |
| 5   | `ca6bd53a49` | fix(line): loading animation keepalive in delivery phase (#86012)                       | monitor.ts                                                   |
| 6   | `636c1b84ad` | test(line): fix reply-chunks test harness + add push retry & quota coverage (#86012)    | reply-chunks.test.ts, send.test.ts                           |
| 7   | `623b5a766a` | fix(line): address ClawSweeper P1 findings                                              | monitor.ts, retry.ts, send.test.ts + 4 reports               |
| 8   | `ff76033e7e` | fix(line): address CI lint/test-type failures                                           | retry.test.ts, retry.ts                                      |

### #94626 Commits (Status command — 4 commits)

| #   | Hash         | Message                                                       | Status files                                                               | Line files                              | Contaminated?                                                                                                  |
| --- | ------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 9   | `08ac84d32f` | fix(status): Phase 0+1 — .catch() fallbacks + tests           | commands-status.ts/`.test`, status-text.ts/`.test`                         | _(none)_                                | **No** — pure #94626                                                                                           |
| 10  | `e0a4c6b5dd` | refactor(status): Phase 2 — selective static import + ??= fix | status-message.runtime.ts, status-queue.runtime.ts, status-text.ts/`.test` | **reply-chunks.test.ts, retry.test.ts** | **Yes** — LINE test improvements bundled in                                                                    |
| 11  | `0bc4f5d147` | fix(status): Phase 2.5 — resolve false positive in fallback   | status-text.ts                                                             | _(none)_                                | **No** — pure #94626                                                                                           |
| 12  | `e4337773d0` | fix(line): Phase 3 — warn log + buildStatusReply timeout      | commands-status.ts, status-text.ts                                         | **send.ts, send.test.ts**               | **Partially** — send.ts/send.test.ts changes are legitimate #94626 (`logVerbose`→`warn` in `logLineHttpError`) |

### Key Observations

1. **Phase 2** (`e0a4c6b5dd`) is the **primary contamination** — commit message says `refactor(status)` but includes LINE test changes (reply-chunks.test.ts, retry.test.ts) that belong to #86012.
2. **Phase 3** (`e4337773d0`) touches send.ts/send.test.ts for legitimate #94626 reasons (upgrading `logVerbose`→`warn` in the LINE-specific `logLineHttpError` function). These LINE file changes overlap with #86012's work in the same files.
3. The **ClawSweeper** commit (`623b5a766a`) and **CI lint fix** commit (`ff76033e7e`) further modify `retry.test.ts` based on the contaminated Phase 2 test changes, creating a dependency chain.

---

## 2. Branches & Existing State

### Local branches

| Branch                  | Description                                                          | Base                                        |
| ----------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| `fix/line-86012`        | Current PR branch — 12 commits (8 #86012 + 4 #94626, 2 contaminated) | `upstream/main`                             |
| `fix/line-94626-status` | Clean #94626 branch — 4 commits, **no LINE file contamination**      | `2c499756ad` (branch point on main lineage) |
| `openclaw-94626`        | Points to `e4337773d0` (same as fix/line-86012 HEAD)                 | Not useful                                  |

### Remote status

```
remotes/samson1357924/fix/line-86012   → remote exists
```

The clean `fix/line-94626-status` does **not** exist on the remote yet.

---

## 3. Cleanup Scheme Analysis

### Scheme A: Maintain Mix (Do Nothing)

**Operations:** 0 — keep branch as-is. Let PR #94680 merge, then open #94626 separately.

**Risk:** Low code risk, but **review confusion is real**:

- Reviewer sees Phase 2 commit message `refactor(status)` modifying LINE test files
- PR body must explain the contamination, defeating the purpose of atomic PRs
- No formal separation; accumulated technical debt in git history

**Verdict:** ⚠️ Simplest but perpetuates contamination. Only acceptable if time is critical.

---

### Scheme B: Remove #94626 Commits from fix/line-86012

**Goal:** Clean `fix/line-86012` so it contains only #86012 changes, then use the existing `fix/line-94626-status` for #94626.

#### Option B1: `git revert` (safe, preserves history)

**Commands:**

```bash
# 1. Create a working backup
git checkout fix/line-86012
git branch fix/line-86012-backup

# 2. Revert the 4 #94626 commits in reverse chronological order
git revert --no-edit e4337773d0   # Phase 3 — removes warn log + LINE send changes
git revert --no-edit 0bc4f5d147   # Phase 2.5 — removes resolveRuntimePluginHealthLine fix
git revert --no-edit e0a4c6b5dd   # Phase 2 — removes static import + LINE test changes
git revert --no-edit 08ac84d32f   # Phase 0+1 — removes .catch() fallbacks
```

**Dependency concern:** Does Phase 3 (`e4337773d0`) depend on #86012 changes in send.ts?

- **send.ts**: Phase 3 changes `logVerbose`→`warn` in `logLineHttpError`. Reverting this only undoes the `warn` import and the `logVerbose→warn` change. The earlier #86012 changes (randomUUID, withRetry, push counter, statusCode/statusMessage in logLineHttpError) are **preserved** because they come from separate earlier commits.
- **send.test.ts**: Phase 3 adds `warnMock` and changes `expect(logVerboseMock)`→`expect(warnMock)`. Reverting this only removes the warnMock changes. The earlier #86012 additions remain.
- **Conclusion:** `git revert` on Phase 3 will **not** affect #86012 changes.

**After revert, the contaminated LINE test changes from Phase 2 are ALSO removed.** This means `reply-chunks.test.ts` and `retry.test.ts` lose the Phase 2 test improvements that actually belong to #86012. **This is a problem.**

**Option B1a: Revert + cherry-pick back the LINE-only delta**

```bash
# After the 4 reverts:
# The Phase 2 LINE test improvements need to be re-applied as a new #86012 commit.

# 1. Create a patch of just the LINE test changes from Phase 2
git show e0a4c6b5dd -- extensions/line/src/reply-chunks.test.ts extensions/line/src/retry.test.ts > /tmp/phase2-line-delta.patch

# 2. Apply as a new commit on the cleaned branch
git apply /tmp/phase2-line-delta.patch
git commit -m "test(line): improve retry and reply-chunks test assertions (#86012)"
```

**Option B2: `git rebase -i` (rewrites history)**

```bash
git checkout fix/line-86012
git rebase -i upstream/main
```

In the rebase TODO list:

```
pick da3d902d9d #86012 commit 1
pick 19096dd690 #86012 commit 2
drop 08ac84d32f # drop Phase 0+1 (pure #94626)
pick e40714cde1 #86012 commit 3
pick d7906c5fdf #86012 commit 4
pick ca6bd53a49 #86012 commit 5
pick 636c1b84ad #86012 commit 6
pick 623b5a766a #86012 commit 7
pick ff76033e7e #86012 commit 8
edit e0a4c6b5dd # edit Phase 2 — remove LINE test changes
drop 0bc4f5d147 # drop Phase 2.5 (pure #94626)
edit e4337773d0 # edit Phase 3 — remove if not needed or keep only status changes
```

During `edit e0a4c6b5dd`:

```bash
# Unstage LINE file changes
git reset HEAD^
git add -u src/status/   # Stage only #94626 files
git commit -m "refactor(status): Phase 2 of #94626 — ..."  # Re-create clean #94626 commit
git stash               # Stash the remaining LINE test changes
git rebase --continue
```

During `edit e4337773d0`:

```bash
# Decide: keep this commit for #86012?
# The send.ts/send.test.ts changes are legitimately #94626.
# Option: keep only the status changes, or drop entirely.
git reset HEAD^
git add -u src/auto-reply/reply/commands-status.ts src/status/status-text.ts
git commit -m "fix(status): Phase 3 of #94626 — warn log + buildStatusReply timeout"
git stash
git rebase --continue
```

**⚠️ Rewrites PR #94680 history.** The remote PR must be force-pushed:

```bash
git push --force-with-lease samson1357924 fix/line-86012
```

**Conflict risk:** Low-to-medium. The 8 #86012 commits do not touch any `src/status/` files, and the 4 #94626 commits do not touch any `extensions/line/` files (ignoring the contamination). Rebasing should produce no file-level conflicts.

#### Pros & Cons

| Factor                  | Score                                                |
| ----------------------- | ---------------------------------------------------- |
| Steps                   | Medium (4–8)                                         |
| Risk of data loss       | Low (with revert + cherry-pick extra step)           |
| PR #94680 compatibility | Rewrites history (B2) or creates revert commits (B1) |
| Clean final state       | ✅ Single-purpose #86012 branch                      |

**Verdict:** ✅ Feasible. B1a (revert + re-apply LINE delta) is recommended for safety.

---

### Scheme C: Cherry-Pick to Clean Branch

**Goal:** Create a new `fix/line-86012-v2` branch from `upstream/main` containing only #86012 changes, abandoning the original branch.

**Commands:**

```bash
# 1. Create new branch from upstream/main
git checkout upstream/main
git checkout -b fix/line-86012-v2

# 2. Cherry-pick the 8 pure #86012 commits
git cherry-pick da3d902d9d  # commit 1 - reply chunks
git cherry-pick 19096dd690  # commit 2 - push counter

# --- gap: 08ac84d32f (#94626) is skipped ---

git cherry-pick e40714cde1  # commit 3 - retry wrapper
git cherry-pick d7906c5fdf  # commit 4 - test infrastructure
git cherry-pick ca6bd53a49  # commit 5 - loading animation
git cherry-pick 636c1b84ad  # commit 6 - reply-chunks test harness

# --- gap: e0a4c6b5dd (#94626 contaminated) is skipped ---

git cherry-pick 623b5a766a  # commit 7 - ClawSweeper
git cherry-pick ff76033e7e  # commit 8 - CI lint fix

# 3. Now apply the LINE test improvements that were in Phase 2
# These are #86012 improvements that got bundled into the contaminated commit
git show e0a4c6b5dd -- extensions/line/src/reply-chunks.test.ts > /tmp/rct.patch
git show e0a4c6b5dd -- extensions/line/src/retry.test.ts > /tmp/rt.patch
git apply /tmp/rct.patch
git apply /tmp/rt.patch
git commit -m "test(line): improve retry and reply-chunks test assertions (#86012)"

# 4. Cherry-pick Phase 3 LINE changes? Only if they should stay
# Phase 3's send.ts changes (logVerbose→warn) are #94626 work — SKIP them.
# Phase 3's commands-status.ts and status-text.ts changes are #94626 — SKIP them.
```

**Conflict risk:** LOW. Verified that:

- `623b5a766a` (ClawSweeper) modifies `retry.ts` and `send.test.ts` — **it does NOT modify retry.test.ts**. The `send.test.ts` duplicate mocks it removes were added by #86012 commits (19096dd690, 636c1b84ad), not by Phase 2.
- `ff76033e7e` (CI lint) modifies `retry.test.ts` — its changes (curly braces, `Math.pow`→`2**`, `.js` import extension) target code established by commits 4–5 (e40714cde1, d7906c5fdf), which are before Phase 2 in chronological order.
- Neither ClawSweeper nor CI lint depend on Phase 2's LINE test changes.
- All 8 cherry-picks apply in chronological order without gaps.

**Difficulty:** Must manually re-apply the Phase 2 LINE delta (reply-chunks.test.ts, retry.test.ts changes) as a new commit after cherry-picking, since those changes were bundled into a #94626 commit.<｜end▁of▁thinking｜>

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="write">
<｜｜DSML｜｜parameter name="content" string="true">

## 4. Commit Ordering (Critical for Cherry-Pick / Rebase)

Actual chronological order within `fix/line-86012` (oldest → newest):

| Seq | Hash             | Issue                     | Description                                       |
| --- | ---------------- | ------------------------- | ------------------------------------------------- |
| 1   | `da3d902d9d`     | #86012                    | reply chunks onReplyError                         |
| 2   | `19096dd690`     | #86012                    | push counter, errorContext                        |
| 3   | `08ac84d32f`     | #94626                    | Phase 0+1 — .catch() fallbacks                    |
| 4   | `e40714cde1`     | #86012                    | retry wrapper, batch push                         |
| 5   | `d7906c5fdf`     | #86012                    | test infrastructure                               |
| 6   | `ca6bd53a49`     | #86012                    | loading animation                                 |
| 7   | `636c1b84ad`     | #86012                    | reply-chunks test harness                         |
| 8   | `623b5a766a`     | #86012                    | ClawSweeper P1 fixes                              |
| 9   | `ff76033e7e`     | #86012                    | CI lint/test-type fixes                           |
| 10  | **`e0a4c6b5dd`** | **#94626 (contaminated)** | **Phase 2 — status refactor + LINE test changes** |
| 11  | `0bc4f5d147`     | #94626                    | Phase 2.5 — resolveRuntimePluginHealthLine        |
| 12  | `e4337773d0`     | #94626                    | Phase 3 — warn log + buildStatusReply timeout     |

**Key insight:** The #94626 commits (3, 10, 11, 12) are interspersed with #86012 commits (1-2, 4-9). The 2nd #94626 commit (Phase 0+1) comes BEFORE the 4th #86012 commit and its LINE files were created/expanded across commits 4–9. The contaminated Phase 2 (commit 10) is the **last** commit that touches LINE files, meaning:

- Commits 1–9 establish LINE file state WITHOUT Phase 2's contaminating changes
- Phase 2's LINE changes (reply-chunks.test.ts, retry.test.ts) are ADDITIVE additions to this established base
- ClawSweeper (8) and CI lint (9) do NOT depend on Phase 2's retry.test.ts/reply-chunks.test.ts changes
  - ClawSweeper: modifies retry.ts (`isRetryableError` function), **not** retry.test.ts
  - CI lint: modifies retry.test.ts line-by-line, but these changes (curly braces, `Math.pow`, `.js` extension) target code from commit 5, not from Phase 2
- ✅ **The 8 #86012 commits (1, 2, 4–9) can be cherry-picked without needing Phase 2's LINE changes as prerequisites**

---

## 5. Cleanup Scheme Analysis

### Scheme A: Maintain Mix (Do Nothing)

**Operations:** 0 — keep branch as-is. Let PR #94680 merge, then open #94626 separately.

**Risk:** Low code risk, but **review confusion is real**:

- Reviewer sees Phase 2 commit message `refactor(status)` modifying LINE test files
- Cannot close PR #94680 until #94626 is also reviewed, creating dependency chain
- PR body must explain the contamination, defeating atomic PR purpose
- Accumulated technical debt in git history

**Verdict:** ⚠️ Simplest but perpetuates contamination. Only acceptable if time-critical.

---

### Scheme B: Remove #94626 from fix/line-86012

**Goal:** Clean `fix/line-86012` to contain only #86012 changes; use `fix/line-94626-status` for #94626.

#### Option B1: `git revert` (safe, preserves history)

```bash
# 1. Create backup
cd C:\Users\samso\projects\openclaw
git checkout fix/line-86012
git branch fix/line-86012-backup

# 2. Revert the 4 #94626 commits in reverse chronological order
git revert --no-edit e4337773d0   # Phase 3 — warn log + buildStatusReply timeout
git revert --no-edit 0bc4f5d147   # Phase 2.5 — resolveRuntimePluginHealthLine fix
git revert --no-edit e0a4c6b5dd   # Phase 2 — static import + ??= fix + LINE test changes
git revert --no-edit 08ac84d32f   # Phase 0+1 — .catch() fallbacks + tests
```

**Does Phase 3 depend on #86012 changes in send.ts?**

- Phase 3 changes `logVerbose`→`warn` in `logLineHttpError`. Reverting only undoes `warn` import and `logVerbose→warn`.
- Earlier #86012 changes (randomUUID, withRetry, push counter, statusCode/statusMessage) were from separate commits and are **preserved**.
- ✅ **Phase 3 revert won't touch #86012 changes.**

**Problem with revert:** After revert, the contaminated LINE test changes from Phase 2 are also removed. The `reply-chunks.test.ts` and `retry.test.ts` lose Phase 2's test improvements that belong to #86012.

**Option B1a: Revert + re-apply LINE-only delta**

```bash
# After the 4 reverts, re-apply the LINE test delta from Phase 2 as a new #86012 commit
git show e0a4c6b5dd -- extensions/line/src/reply-chunks.test.ts extensions/line/src/retry.test.ts > /tmp/phase2-line-delta.patch
git apply /tmp/phase2-line-delta.patch
git add -u extensions/line/
git commit -m "test(line): improve retry and reply-chunks test assertions (#86012)"
```

#### Option B2: `git rebase -i` (rewrites history)

```bash
git checkout fix/line-86012
git rebase -i upstream/main
```

In the rebase TODO list:

```
pick da3d902d9d  # #86012
pick 19096dd690  # #86012
drop 08ac84d32f  # DROP Phase 0+1 (pure #94626)
pick e40714cde1  # #86012
pick d7906c5fdf  # #86012
pick ca6bd53a49  # #86012
pick 636c1b84ad  # #86012
pick 623b5a766a  # #86012
pick ff76033e7e  # #86012
drop e0a4c6b5dd  # DROP Phase 2 (contaminated)
drop 0bc4f5d147  # DROP Phase 2.5 (pure #94626)
drop e4337773d0  # DROP Phase 3 (pure #94626, legitimate LINE changes stay with #94626)
```

Then re-apply the LINE test delta as a new commit (same as B1a step 3).

**⚠️ Force-push required:** `git push --force-with-lease samson1357924 fix/line-86012`

**Conflict risk:** Low — #86012 commits never touch `src/status/`, and after dropping all #94626 commits there are zero conflicting lines.

#### Pros & Cons

| Factor            | B1 (revert)                       | B2 (rebase)                    |
| ----------------- | --------------------------------- | ------------------------------ |
| Steps             | 6                                 | 5                              |
| History rewrite?  | No (creates 5 new revert commits) | Yes (drops commits)            |
| PR compatibility  | OK (fast-forward)                 | Force-push required            |
| Risk              | Low                               | Low                            |
| Clean final state | ⚠️ Revert commits visible         | ✅ Clean single-purpose branch |

**Verdict:** ✅ B2 (rebase) preferred if history cleanliness matters. B1a (revert) if force-push is not desired.

---

### Scheme C: Cherry-Pick to New Branch

**Goal:** Create `fix/line-86012-v2` from `upstream/main` with only #86012 changes.

```bash
git checkout upstream/main
git checkout -b fix/line-86012-v2

# Cherry-pick the 8 #86012 commits (skip #94626 commits 3, 10, 11, 12)
git cherry-pick da3d902d9d  # commit 1 — reply chunks
git cherry-pick 19096dd690  # commit 2 — push counter
# SKIP: 08ac84d32f (Phase 0+1, #94626)
git cherry-pick e40714cde1  # commit 4 — retry wrapper
git cherry-pick d7906c5fdf  # commit 5 — test infrastructure
git cherry-pick ca6bd53a49  # commit 6 — loading animation
git cherry-pick 636c1b84ad  # commit 7 — reply-chunks test harness
# SKIP: e0a4c6b5dd (Phase 2, #94626 contaminated)
git cherry-pick 623b5a766a  # commit 8 — ClawSweeper P1 fixes
git cherry-pick ff76033e7e  # commit 9 — CI lint fixes

# Re-apply Phase 2's LINE test improvements as a new #86012 commit
git show e0a4c6b5dd -- extensions/line/src/reply-chunks.test.ts > /tmp/rct.patch
git show e0a4c6b5dd -- extensions/line/src/retry.test.ts > /tmp/rt.patch
git apply /tmp/rct.patch
git apply /tmp/rt.patch
git commit -m "test(line): improve retry and reply-chunks test coverage (#86012)"
```

**Conflict risk:** LOW. Verified that:

- `623b5a766a` (ClawSweeper) modifies `retry.ts` (not `retry.test.ts`) — no dependency on Phase 2
- `ff76033e7e` (CI lint) modifies `retry.test.ts` but only changes lines from commit 5 (`d7906c5fdf`), not Phase 2
- All 8 cherry-picks apply in chronological order without gaps

**Pros:** Cleanest state. New branch, no history rewrite. Old `fix/line-86012` preserved as backup.
**Cons:** Abandons existing PR (#94680). Must open new PR from `fix/line-86012-v2`.

**Verdict:** ✅ Highly recommended — lowest risk, cleanest result.

---

### Scheme D: Split PR — Two Independent Branches

**Goal:**

1. Clean `fix/line-86012` (use Scheme B or C)
2. Push existing `fix/line-94626-status` as #94626 PR

**The #94626 branch already exists:**

```
fix/line-94626-status  (local, 4 commits, base 2c499756ad)
├── 094e2fe0b5  Phase 0+1 — .catch() fallbacks (#94626)
├── d9d2c04dc6  Phase 2 — static import + ??= fix (NO LINE files!)
├── 7fabf51fab  Phase 2.5 — resolveRuntimePluginHealthLine (#94626)
└── 1f9b44f3fc  Phase 3 — warn log + buildStatusReply timeout (#94626)
```

**Note about Phase 3:** The clean `fix/line-94626-status` branch's Phase 3 (`1f9b44f3fc`) has **identical** LINE file changes to the original. This is expected — those send.ts/send.test.ts changes (`logVerbose`→`warn`) are legitimate #94626 work.

**Push the clean #94626 branch:**

```bash
git push samson1357924 fix/line-94626-status:fix/status-94626
```

Then open a new PR.

**After merging both PRs, there will be NO conflict between them** because:

- Files changed by `fix/line-86012` are entirely in `extensions/line/`
- Files changed by `fix/line-94626-status` are entirely in `src/status/` and `src/auto-reply/reply/`
- The exception is `send.ts`/`send.test.ts`, where Phase 3's changes are independent code additions (`warn` import, `logVerbose`→`warn` in `logLineHttpError`) that don't conflict with #86012's changes
- ✅ **No code dependency — safe to merge in any order**

**Verdict:** ✅ Recommended as the end state. Combines Scheme B or C (for #86012) + push clean branch (for #94626).

---

## 6. Recommendation

| Priority | Scheme                              | Why                                                                                                                                  |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 🥇       | **D** (Split) + **C** (Cherry-Pick) | Cleanest split: new `fix/line-86012-v2` branch + push existing `fix/line-94626-status`. No history rewrite. Lowest risk of conflict. |
| 🥈       | **D** + **B2** (Rebase)             | If you want to preserve PR #94680, rebase the existing branch to drop #94626 commits. Requires force-push.                           |
| 🥉       | **A** (Maintain Mix)                | Acceptable only if time is critical. Document contamination explicitly in PR body.                                                   |

### Recommended Execution (🥇 D+C)

```bash
# === Step 1: Create clean #86012 branch ===
git checkout upstream/main
git checkout -b fix/line-86012-v2
git cherry-pick da3d902d9d 19096dd690 e40714cde1 d7906c5fdf ca6bd53a49 636c1b84ad 623b5a766a ff76033e7e

# === Step 2: Re-apply Phase 2's LINE delta ===
git show e0a4c6b5dd -- extensions/line/src/reply-chunks.test.ts > /tmp/rct.patch
git show e0a4c6b5dd -- extensions/line/src/retry.test.ts > /tmp/rt.patch
git apply /tmp/rct.patch
git apply /tmp/rt.patch
git commit -m "test(line): improve retry and reply-chunks test coverage (#86012)"

# === Step 3: Open new PR from fix/line-86012-v2 ===
git push samson1357924 fix/line-86012-v2
# Then open PR via GitHub UI

# === Step 4: Push clean #94626 branch ===
git push samson1357924 fix/line-94626-status:fix/status-94626
# Then open separate PR for #94626

# === Step 5: Close original PR #94680 (optional) ===
# Close PR #94680 once the new fix/line-86012-v2 PR replaces it.
```

### Verification Steps

After cleanup, verify with:

```bash
# 1. Confirm no #94626 files in cleaned branch
git log --oneline upstream/main..fix/line-86012-v2 -- src/status/ src/auto-reply/reply/commands-status*
# → Should return NO commits

# 2. Confirm no #86012 files in #94626 branch
git log --oneline upstream/main..fix/line-94626-status -- extensions/line/
# → Should return NO commits (Phase 3 send.ts/send.test.ts is expected)

# 3. Confirm tests pass
git checkout fix/line-86012-v2
pnpm vitest run extensions/line/
git checkout fix/line-94626-status
pnpm vitest run src/status/ src/auto-reply/reply/commands-status.test.ts
```

---

## Appendix: Cross-Reference to Other Reports

| File                           | Description                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `audit-contamination-deps.md`  | Code dependency analysis — confirmed no cross-imports between #86012 and #94626 |
| `audit-contamination-files.md` | Per-file issue attribution with contamination marking                           |
| `explorer-ci-failure.md`       | CI failure analysis for #86012                                                  |
| `explorer-edge-cases.md`       | Edge case analysis for #86012 LINE fix                                          |

---

_End of audit report._
