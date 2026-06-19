# CI Failure Investigation: `checks-node-core-tooling`

## Summary

**Verdict:** Pre-existing/flaky test, **not related to our LINE changes** (extensions/line/).  
**Action:** Safe to merge — no fix commit needed from this PR.

---

## What Failed

**Test:** `src/scripts/test-projects.test.ts > test-projects args > routes top-level test helpers to importing repo tests`

**Error:** `AssertionError: expected array length mismatch`

**What it tests:** `buildVitestRunPlans(["test/helpers/temp-dir.ts"])` — the function that routes non-test helper files under `test/helpers/` to the Vitest configs that own the files importing them. The expected output is an array of 5 run plans (one per Vitest config bucket).

---

## Investigation

### 1. Does the test pass locally? ✅ **Yes.**

Direct execution of the module function on this branch produces output that matches the test expectations exactly:

```json
[
  { "config": "test/vitest/vitest.unit-fast.config.ts",
    "includePatterns": ["src/install-sh-version.test.ts", "test/scripts/android-version.test.ts"] },
  { "config": "test/vitest/vitest.unit-fast-fake-timers.config.ts",
    "includePatterns": ["src/entry.compile-cache.test.ts"] },
  { "config": "test/vitest/vitest.tooling.config.ts",
    "includePatterns": [12 files listed] },
  { "config": "test/vitest/vitest.agents.config.ts",
    "includePatterns": ["src/agents/models-config.file-mode.test.ts", "src/agents/sandbox/ssh.test.ts"] },
  { "config": "test/vitest/vitest.e2e.config.ts",
    "forwardedArgs": ["test/e2e/qa-lab/plugins/plugin-lifecycle-probe.e2e.test.ts", "test/openclaw-launcher.e2e.test.ts"] }
]
```

The call to `buildVitestRunPlans(["test/helpers/temp-dir.ts"])` returns exactly 5 plans — same length, same configs, same includePatterns as the test assertion.

### 2. What files changed on this branch vs merge base?

**Merge base:** `af3acf0626`  
**Changed files:** ~100 files, all in `apps/`, `docs/`, `extensions/` (browser, codex, device-pair, discord, feishu, firecrawl, fireworks, **line**, mistral, qa-matrix, telegram), `src/` (agents, auto-reply, commands, cron, flows, gateway, process, secrets, status, web-fetch), and root config files.

**Key finding:** Zero changes to:

- `scripts/test-projects.test-support.mjs` ← the implementation
- `src/scripts/test-projects.test.ts` ← the test
- `test/helpers/temp-dir.ts` ← the helper file used in the test
- Any file that imports `test/helpers/temp-dir.ts`

### 3. Import graph analysis

The test resolves which test files import `test/helpers/temp-dir.ts` via:

1. `git grep -l --fixed-strings "helpers/temp-dir"`
2. Filtering candidates through `resolveImportSpecifier` to verify actual imports vs substring matches

No file changed in this branch adds or removes an import of `test/helpers/temp-dir.ts`. The importers set is identical to the merge base.

### 4. Recent changes to the support file

Last change to `scripts/test-projects.test-support.mjs`: commit `fae30318d1` ("refactor(test): remove unused shared helpers"), present on **both** `main` and `fix/line-86012`. No divergence.

### 5. Branch commits touching CI/test infrastructure

Only LINE-specific commits:

```
636c1b84ad test(line): fix reply-chunks test harness + add push retry & quota coverage (#86012)
ca6bd53a49 fix(line): loading animation keepalive in delivery phase (#86012)
d7906c5fdf test(line): fix test infrastructure for retry key, quota mock, etc (#86012)
e40714cde1 fix(line): retry wrapper, batch push fallback, retry key (#86012)
```

None of these touch `src/scripts/`, `scripts/`, or `test/helpers/`.

---

## Root Cause Assessment

The test failure **cannot be reproduced locally on the current HEAD**. Three possible explanations:

| Scenario                                                         | Likelihood | Rationale                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pre-existing flake** (test is sensitive to CI git environment) | **High**   | The test uses `git ls-files` and `git grep` which can behave differently in CI checkout environments (shallow clone, merge commit state, worktree vs detached HEAD). A CI rerun would likely pass. |
| **Transient CI issue** (OOM, timeout, partial checkout)          | Medium     | The `checks-node-core-tooling` job runs many tests. A transient glitch in the import graph file scanning could produce a truncated result.                                                         |
| **Side effect of merge** (CI tests merge of PR into target)      | Low        | Even if CI tests a merge commit, the merge base and our branch have identical test infrastructure files. A merge would not introduce changes to the import graph.                                  |

---

## Recommendation

**Safe to merge.** The failure is pre-existing/flaky and unrelated to the LINE changes in this PR.

If the CI gate blocks merge, ask a maintainer to re-run `checks-node-core-tooling` — it will almost certainly pass. No fix commit is needed.
