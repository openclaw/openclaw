# Audit: Issue Contamination Analysis — `fix/line-86012` vs `upstream/main`

**Generated:** Fri 2026-06-19 10:52 GMT+8
**Branch:** `fix/line-86012`
**Base:** `upstream/main`
**Commits analyzed:** 12 (da3d902d9d..e4337773d0)

---

## 1. All Commits on `fix/line-86012` (not on `upstream/main`)

| #   | Hash         | Message                                                                                 | Files Changed |
| --- | ------------ | --------------------------------------------------------------------------------------- | ------------- |
| 1   | `da3d902d9d` | fix(line): pass onReplyError to sendLineReplyChunks in text delivery path               | 1             |
| 2   | `19096dd690` | fix(line): local push counter, pushMessageLine errorContext, startup quota log (#86012) | 2             |
| 3   | `08ac84d32f` | fix(status): add .catch() fallbacks to all 4 dynamic runtime loaders + tests            | 4             |
| 4   | `e40714cde1` | fix(line): retry wrapper, batch push fallback, retry key (#86012)                       | 4             |
| 5   | `d7906c5fdf` | test(line): fix test infrastructure for retry key, quota mock, etc (#86012)             | 4             |
| 6   | `ca6bd53a49` | fix(line): loading animation keepalive in delivery phase (#86012)                       | 1             |
| 7   | `636c1b84ad` | test(line): fix reply-chunks test harness + add push retry & quota coverage (#86012)    | 2             |
| 8   | `623b5a766a` | fix(line): address ClawSweeper P1 findings                                              | 7             |
| 9   | `ff76033e7e` | fix(line): address CI lint/test-type failures                                           | 2             |
| 10  | `e0a4c6b5dd` | refactor(status): Phase 2 of #94626 — selective static import + ??= fix                 | 6             |
| 11  | `0bc4f5d147` | fix(status): resolve false positive in resolveRuntimePluginHealthLine fallback          | 1             |
| 12  | `e4337773d0` | fix(line): Phase 3 of #94626 — warn log + buildStatusReply timeout                      | 4             |

---

## 2. Per-File Issue Attribution (Actual, Not by Commit Message)

Legend:

- **#86012** = LINE extension work (retry, push, quota, reply-chunks, loading animation)
- **#94626** = Status/runtime loader reliability work (dynamic import error handling, ??= fix)

### Files belonging to #86012

| File                                            | Commits modifying it                                             | Attribution                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `extensions/line/src/auto-reply-delivery.ts`    | da3d902d9d, e40714cde1                                           | **#86012** — Both changes are about the LINE retry/push delivery path               |
| `extensions/line/src/monitor.ts`                | 19096dd690, ca6bd53a49, 623b5a766a                               | **#86012** — Push counter, loading animation, delivery cleanup                      |
| `extensions/line/src/monitor.lifecycle.test.ts` | d7906c5fdf                                                       | **#86012** — Retry key test mock infrastructure                                     |
| `extensions/line/src/reply-chunks.ts`           | e40714cde1                                                       | **#86012** — Batch push fallback 5-at-a-time                                        |
| `extensions/line/src/send.ts`                   | 19096dd690, d7906c5fdf, e40714cde1, **e4337773d0\***             | **#86012** (+ #94626 contamination in e4337773d0)                                   |
| `extensions/line/src/send.test.ts`              | 19096dd690, d7906c5fdf, 636c1b84ad, 623b5a766a, **e4337773d0\*** | **#86012** (+ #94626 contamination in e4337773d0)                                   |
| `extensions/line/src/reply-chunks.test.ts`      | 636c1b84ad, **e0a4c6b5dd\***                                     | **#86012** (e0a4c6b5dd content is batch push assertion refinement, not status work) |
| `extensions/line/src/retry.ts`                  | e40714cde1, d7906c5fdf, 623b5a766a, ff76033e7e                   | **#86012** — Retry wrapper, error handling, lint fixes                              |
| `extensions/line/src/retry.test.ts`             | d7906c5fdf, ff76033e7e, **e0a4c6b5dd\***                         | **#86012** (e0a4c6b5dd content is retry test refinements, not status work)          |
| `reports/issue-86012/explorer-ci-failure.md`    | 623b5a766a                                                       | **#86012** — Report file about #86012                                               |
| `reports/issue-86012/explorer-edge-cases.md`    | 623b5a766a                                                       | **#86012** — Report file about #86012                                               |
| `reports/issue-86012/explorer-security.md`      | 623b5a766a                                                       | **#86012** — Report file about #86012                                               |
| `reports/issue-86012/explorer-test-strategy.md` | 623b5a766a                                                       | **#86012** — Report file about #86012                                               |

\* = Contaminated by a commit whose message targets the other issue.

### Files belonging to #94626

| File                                           | Commits modifying it                           | Attribution                                                       |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| `src/auto-reply/reply/commands-status.test.ts` | 08ac84d32f                                     | **#94626** — Dynamic loader error path tests                      |
| `src/auto-reply/reply/commands-status.ts`      | 08ac84d32f, e4337773d0                         | **#94626** — .catch() fallbacks + buildStatusReply timeout        |
| `src/status/status-message.runtime.ts`         | e0a4c6b5dd                                     | **#94626** — Eliminated triple-hop                                |
| `src/status/status-queue.runtime.ts`           | e0a4c6b5dd                                     | **#94626** — Eliminated wrapper                                   |
| `src/status/status-text.test.ts`               | 08ac84d32f, e0a4c6b5dd                         | **#94626** — Error path tests + removed deprecated tests          |
| `src/status/status-text.ts`                    | 08ac84d32f, e0a4c6b5dd, 0bc4f5d147, e4337773d0 | **#94626** — ??= fix, dynamic loader refactor, false positive fix |

### Ambiguous attribution

| File                                                             | Commits    | Notes                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/line/src/auto-reply-delivery.ts` (commit da3d902d9d) | da3d902d9d | Commit message says "ClawSweeper finding (#94626) / Related: #86012, #94626". The code change (passing onReplyError) is part of the retry path for #86012 but the ClawSweeper finding belongs to #94626. **Best attribution: #86012** (file is LINE extension, change is about LINE retry delivery). |

---

## 3. Deep Analysis: `e0a4c6b5dd` Commit Contamination

This commit is **labeled as #94626** ("refactor(status): Phase 2 of #94626") but includes changes to two `extensions/line/src/` test files that are **functionally part of #86012**.

### `extensions/line/src/reply-chunks.test.ts` changes in e0a4c6b5dd

```
-    // Chunks 6 and 7 fit in one batch (5 messages at a time)
     expect(pushMessagesLine).toHaveBeenCalledTimes(1);
-    expect(pushMessagesLine).toHaveBeenCalledWith(
-      "line:group:1",
-      [
-        { type: "text", text: "6" },
-        { type: "text", text: "7" },
-      ],
-      { cfg: LINE_TEST_CFG, accountId: undefined },
-    );
+    expect(pushMessagesLine).toHaveBeenCalledWith("line:group:1", [{ type: "text", text: "6" }], {
+      cfg: LINE_TEST_CFG,
+      accountId: undefined,
+    });
```

- Removes a comment about batching
- Changes assertion: was expecting **2 items in one push batch** → now expects **1 item pushed, 1 item sent via `pushTextMessageWithQuickReplies`**
- Same pattern in the second test case: was expecting 3 chunks → now expects 2 chunks pushed, 1 routed to quick-replies

**Verdict:** These assertions are about **batch push behavior** (5-at-a-time push grouping from #86012 Phase 3). The test logic was refined to match the actual #86012 implementation. **Actual issue: #86012.**

### `extensions/line/src/retry.test.ts` changes in e0a4c6b5dd

```
-import { isRetryableError, withRetry } from "./retry.js";
+import { isRetryableError, withRetry, DEFAULT_RETRY } from "./retry";
-    it("retries network errors (no status)", () => {
+    it("retries unknown 429", () => {
+      expect(isRetryableError({ statusCode: 429, body: { message: "unknown" } }, 0)).toBe(true);
+    });
+    it("retries network errors (no status code)", () => {
       expect(isRetryableError(new Error("ECONNREFUSED"), 0)).toBe(true);
       expect(isRetryableError({}, 0)).toBe(true);
+      expect(isRetryableError(null, 0)).toBe(true);
     });
```

- Adds `DEFAULT_RETRY` to import (retry config constant)
- Adds test for unknown 429 (statusCode 429) being retryable
- Adds test for null error being retryable
- Renames/clarifies test descriptions
- Changes retry count assertion from maxRetries=1→2 (so initial+2=3 calls)
- Adds "custom retryable check" test

**Verdict:** All changes are about the **retry module's isRetryableError behavior** — specifically refining tests to match LINE SDK error shapes and retry behavior. This is part of the #86012 retry infrastructure. **Actual issue: #86012.**

### Conclusion on e0a4c6b5dd:

The commit **should have been split**: the 4 `src/status/` files belong to #94626, while the 2 `extensions/line/src/` test files belong to #86012. Including them in a single commit is a **labeling/scope contamination** — the changes were likely staged together because the test refinements were discovered during the status work, but they are functionally unrelated to #94626.

---

## 4. Files with Cross-Issue Contamination (Modified by Both Issues)

These are files that received changes from **both #86012-labeled and #94626-labeled commits**, meaning they carry changes from both issues.

| #   | Contaminated File                              | #86012 Changes                                                                                                                                | #94626 Changes                                                      | Risk                                                                                                                                       |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **`extensions/line/src/send.test.ts`**         | Push counter, retry key, quota tests, mock cleanup (19096dd690, d7906c5fdf, 636c1b84ad, 623b5a766a)                                           | `warnMock` addition for logVerbose→warn upgrade (e4337773d0)        | **Low** — both changes touch different parts of the test file; no overlapping assertions                                                   |
| 2   | **`extensions/line/src/send.ts`**              | `pushMessageLine` → `pushLineMessages` with errorContext, retry key header, LINE SDK statusCode handling (19096dd690, d7906c5fdf, e40714cde1) | `logVerbose` → `warn` in `logLineHttpError` (e4337773d0)            | **Low** — different functions; the warn change is a one-line import + call-site fix in `logLineHttpError`, not related to retry/push logic |
| 3   | **`extensions/line/src/reply-chunks.test.ts`** | Test harness fix, push coverage (636c1b84ad)                                                                                                  | **Commit-labeled** #94626 but actual content is #86012 (e0a4c6b5dd) | **None** — both instances are #86012 work                                                                                                  |
| 4   | **`extensions/line/src/retry.test.ts`**        | 12 retry tests, lint fixes (d7906c5fdf, ff76033e7e)                                                                                           | **Commit-labeled** #94626 but actual content is #86012 (e0a4c6b5dd) | **None** — both instances are #86012 work                                                                                                  |

### Files that are #86012-only (clean)

- `extensions/line/src/auto-reply-delivery.ts`
- `extensions/line/src/monitor.ts`
- `extensions/line/src/monitor.lifecycle.test.ts`
- `extensions/line/src/reply-chunks.ts`
- `extensions/line/src/retry.ts`
- `reports/issue-86012/*.md`

### Files that are #94626-only (clean)

- `src/auto-reply/reply/commands-status.test.ts`
- `src/auto-reply/reply/commands-status.ts`
- `src/status/status-message.runtime.ts`
- `src/status/status-queue.runtime.ts`
- `src/status/status-text.test.ts`
- `src/status/status-text.ts`

---

## 5. Recommendations

1. **Real contamination (high priority):** `extensions/line/src/send.test.ts` and `extensions/line/src/send.ts` contain changes from both issues. When cherry-picking or merging these files into a release branch, be aware that changes from the other issue will come along.

2. **Commit-level contamination (medium priority):** `e0a4c6b5dd` ("refactor(status): Phase 2 of #94626") includes 2 files that belong to #86012. If cherry-picking #94626 commits to a status-only branch, `extensions/line/src/reply-chunks.test.ts` and `extensions/line/src/retry.test.ts` would be incorrectly pulled in. If cherry-picking #86012 commits, the 4 `src/status/` files in the same commit would be missed.

3. **Cherry-pick guidance for #86012 only:**
   - Pick all commits except `08ac84d32f`, `e0a4c6b5dd` (status part only), `0bc4f5d147`, `e4337773d0` (status part only)
   - For `e0a4c6b5dd`: `git cherry-pick -n` then `git checkout -- extensions/line/src/` to keep only the LINE files (or vice versa)
   - For `e4337773d0`: the `warnMock` change in `send.test.ts` and the `warn()` change in `send.ts` are functionally part of #94626 but if you need them, they are small and non-conflicting with #86012 changes

4. **Cherry-pick guidance for #94626 only:**
   - Pick `08ac84d32f`, `0bc4f5d147` fully
   - For `e0a4c6b5dd`: pick only `src/status/` files
   - For `e4337773d0`: pick only `src/` files (not `extensions/line/`), but note the `warn()` change in `extensions/line/src/send.ts` is desirable for production visibility
