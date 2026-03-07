# PR Review: RTK Exec Integration

**Reviewer:** AbundanceM Agent (subagent)  
**Date:** 2026-03-07  
**Branch:** `feature/rtk-exec-integration`

---

## ✅ What Looks Good

- **Security: `execFileSync`/`execFileAsync` used correctly** — no shell interpretation, command passed as array argument to `rtk rewrite`. This eliminates the shell injection risk the plan flagged. Well done.
- **Guard conditions are complete and correct:**
  - `host === "gateway"` ✅
  - `!elevatedRequested` ✅
  - `defaults?.compactOutput !== "off"` ✅
  - rtk availability check inside `tryRtkRewrite` ✅
- **SafeBins `execCommandOverride` handled correctly** — `const commandToRewrite = execCommandOverride ?? params.command` ensures rtk rewrites the already-sanitized safeBins command when present. Matches plan exactly.
- **Integration point is exactly right** — after `validateScriptFileForShellBleed`, before `runExecProcess`. Original `params.command` preserved for display/logging/sessions.
- **Config wiring is complete:** types (`ExecToolDefaults`, `ExecToolConfig`), Zod schema (`compactOutput: z.enum(["auto", "off"]).optional()`), and passthrough (`pi-tools.ts`) all updated consistently.
- **Graceful degradation** — all error paths in `tryRtkRewrite` return `null`, so any rtk failure silently falls back to the original command.
- **Tests cover the core paths** — detection success/failure, rewrite success/null/error/timeout/empty, argument passing verification, cache reset.
- **Import conventions followed** — `.js` extensions, alphabetical-ish ordering, no unused imports.
- **`initRtkDetection()` idempotent** — safe to call multiple times, runs detection only once.

---

## ❌ Issues Found

### 1. `detectRtk` uses sync `execFileSync` inside async wrapper — blocks event loop

**File:** `src/agents/rtk-rewrite.ts:22-32`

`detectRtk` is declared `async` but calls `execFileSync` which blocks the event loop for up to 3 seconds. Since `initRtkDetection()` is called in `createExecTool` (which runs during agent initialization), this blocks the entire event loop at startup if rtk is slow to respond or not found.

The rewrite path correctly uses `execFileAsync` — detection should too for consistency.

**Severity:** Medium — one-time 3s block at startup is not catastrophic, but inconsistent with the async design and could delay agent readiness.

### 2. Missing integration tests

**Plan specifies:** `src/agents/bash-tools.exec.rtk.test.ts` with 7 integration test cases (gateway+rtk, gateway+no-rtk, compactOutput=off, sandbox skip, node skip, elevated skip, safeBins+rtk).

**Actual:** Only unit tests in `rtk-rewrite.test.ts` were created. The integration tests verifying the actual wiring in `bash-tools.exec.ts` are missing.

**Severity:** Medium — the unit tests cover the module's logic, but there's no test proving the 6-line block in `bash-tools.exec.ts` actually calls `tryRtkRewrite` under the right conditions and skips it under the wrong ones.

### 3. `promisify` applied at module level — mock ordering concern

**File:** `src/agents/rtk-rewrite.ts:5`

```typescript
const execFileAsync = promisify(execFile);
```

This runs at import time. The tests use `vi.mock("node:child_process")` which hoists above imports, and `vi.resetModules()` + dynamic `import()` in `beforeEach` — this should work because `promisify` wraps the already-mocked `execFile`. **Verified: tests are correct.** However, this is fragile — if someone changes the test setup to static imports, it will silently break.

**Severity:** Low — works now, but add a comment in the test file.

### 4. No `logWarn` on detection failure

**File:** `src/agents/rtk-rewrite.ts:30`

Detection success logs via `logInfo`, but detection failure is silent. A `logWarn` or `logInfo` on failure would help operators debug why rtk isn't activating when expected.

**Severity:** Low — nice to have for operability.

---

## 🔧 Suggested Fixes

### Fix #1: Make `detectRtk` fully async

```typescript
// src/agents/rtk-rewrite.ts — replace detectRtk function (lines 22-32)

async function detectRtk(): Promise<boolean> {
  try {
    await execFileAsync("rtk", ["--version"], {
      timeout: 3000,
    });
    rtkAvailable = true;
    logInfo("exec: rtk detected — compact output enabled");
    return true;
  } catch {
    rtkAvailable = false;
    return false;
  }
}
```

Also remove the `execFileSync` import since it's no longer needed:

```typescript
// Line 1: change to
import { execFile } from "node:child_process";
```

Update tests to remove `execFileSyncMock` and use `execFileMock` for detection too.

### Fix #2: Add integration test file

Create `src/agents/bash-tools.exec.rtk.test.ts` with at minimum:

- Gateway + rtk available → `execCommand` is rewritten
- Gateway + `compactOutput: "off"` → `tryRtkRewrite` never called
- Non-gateway host → rtk rewrite block skipped

### Fix #3: Add comment about mock fragility in test

```typescript
// src/agents/rtk-rewrite.test.ts — add near top of describe block
// NOTE: vi.mock hoists above imports. The dynamic import() in beforeEach
// ensures promisify(execFile) wraps the mock. Do NOT change to static imports.
```

### Fix #4: Log detection failure

```typescript
// src/agents/rtk-rewrite.ts — in detectRtk catch block
  } catch {
    rtkAvailable = false;
    logInfo("exec: rtk not found — compact output disabled");
    return false;
  }
```

(Import `logInfo` is already present — no change needed.)

---

## Summary

| Area             | Verdict                                                           |
| ---------------- | ----------------------------------------------------------------- |
| Security         | ✅ Solid — `execFile` not `exec`, no shell injection vectors      |
| Correctness      | ✅ Logic is correct, guards are complete                          |
| Plan conformance | ⚠️ Mostly matches — async detection and integration tests missing |
| Tests            | ⚠️ Unit tests good, integration tests absent                      |
| Conventions      | ✅ Follows codebase patterns                                      |
| Bugs             | None found                                                        |

---

## Final Verdict: **REQUEST_CHANGES**

The implementation is clean, secure, and well-structured. Two changes needed before merge:

1. **Fix #1 (Medium):** Make `detectRtk` fully async with `execFileAsync` instead of blocking `execFileSync`
2. **Fix #2 (Medium):** Add integration tests as specified in the plan

Fix #3 and #4 are nice-to-haves that can be addressed in the same pass.
