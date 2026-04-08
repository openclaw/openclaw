WORK LOG

Add your findings and worklogs by appending to the end of this file. Do not overwrite anything that is existing in this file. Write with the format being used.

[CODEX]

I've brought work into the workstream.

[CLAUDE]

I've assigned the work to eleqtrizit.

[CLAUDE REVIEW]

## Branch: `logging-redaction`

### Issue Context

GHSA-rw2r-3f8f-c5q8 (NVIDIA-dev/openclaw-tracking#364) — **Severity: High**

A client authenticated with only `operator.read` scope can extract reusable `hookToken` and `pushToken` credentials from `logs.tail` output, then replay the `hookToken` as a bearer token against hook HTTP ingress (`POST /hooks/agent`). This turns a documented read-only scope into a write-capable credential disclosure path.

**Root cause chain:**

1. `buildGogWatchServeArgs()` includes `--token <pushToken>` and `--hook-token <hookToken>` in the `gog` argv.
2. `gmail-watcher.ts` and `gmail-ops.ts` log `args.join(" ")` verbatim before spawning the process — writing both secrets to the log file.
3. `logs.tail` is scoped to `operator.read` and returns raw log file lines without any redaction.
4. The `redactSensitiveText()` CLI pattern did not cover `--hook-token`, only `--token`.

---

### Goal of the Branch

Fix the credential disclosure path with defense in depth across three layers:

1. **Source layer**: Stop including secrets in the logged argv string.
2. **Pattern layer**: Extend `redactSensitiveText()` to catch `--hook-token` in case secrets appear in other log paths.
3. **Output layer**: Apply redaction to all lines returned by `readConfiguredLogTail()` before they reach `logs.tail` callers.

---

### What Was Done

**`src/hooks/gmail.ts`** _(currently has an uncommitted modification — see critical note below)_

- Defines `GMAIL_WATCH_SENSITIVE_FLAGS = new Set(["--token", "--hook-url", "--hook-token"])`.
- Adds `buildGogWatchServeLogArgs(cfg)` which calls `buildGogWatchServeArgs()` and filters out every sensitive flag and its immediately following value argument.

**`src/hooks/gmail-watcher.ts`** and **`src/hooks/gmail-ops.ts`**

- Both `spawnGogServe()` callers updated to log `buildGogWatchServeLogArgs(cfg)` instead of the raw `buildGogWatchServeArgs(cfg)`.

**`src/logging/redact.ts`**

- CLI flag regex extended from `--(?:api[-_]?key|token|secret|password|passwd)` to also include `hook[-_]?token`.

**`src/logging/log-tail.ts`**

- `readConfiguredLogTail()` now maps each line through `redactSensitiveText()` before returning the result.

**Tests**

- `src/hooks/gmail.test.ts`: Asserts `buildGogWatchServeLogArgs` output contains no `--token`, `--hook-token`, `push-token`, or `hook-token` values, and matches the exact expected safe arg list.
- `src/logging/redact.test.ts`: Asserts `--hook-token` values are masked by the extended CLI pattern.
- `src/gateway/server-methods/server-methods.test.ts`: Integration test writing a raw line containing both `--token` and `--hook-token` secrets to a temp log file, then verifying `logs.tail` returns the redacted form.

---

### Assessment

**Correctness** — The three-layer approach correctly addresses the vulnerability. The filter logic in `buildGogWatchServeLogArgs` is sound: it removes both the flag (`--hook-token`) and its value by checking whether the current arg or its predecessor is in the sensitive set. The `--hook-url` being included in the sensitive set is a good defensive call even though the issue only explicitly named `--token` and `--hook-token`.

**Defense-in-depth coverage** — Remediation items 1, 3, and 4 from the issue are addressed. Item 2 (apply `redactSensitiveText()` before file writes, i.e., in the file logger itself) was **not implemented**. This means the log file on disk still retains the raw secrets from any already-written lines. Direct filesystem access to the log file would still expose historic credentials. This is documented as "defense in depth" in the issue, so it is a known gap rather than a mistake, but it is worth calling out.

**Code quality**

- The filter-based implementation (current uncommitted state) is **strictly better** than the committed inline approach: it delegates to `buildGogWatchServeArgs()` so any future additions to the real args builder are automatically reflected in the safe log version without requiring a parallel update. The committed version duplicated the args list, which is a DRY violation and a maintenance trap.
- `GMAIL_WATCH_SENSITIVE_FLAGS` as a `Set` is the right structure for O(1) membership checks.
- The regex change (`hook[-_]?token`) handles both `--hook-token` and `--hook_token`; slightly over-broad but harmless.
- `getDefaultRedactPatterns()` is called on every line in `log-tail.ts` on every `logs.tail` call. This is fine for a tail of 500 lines, but `getDefaultRedactPatterns()` compiles patterns each call. If it is not memoized internally, this should be pulled outside the `.map()` — allocate once, iterate. Worth checking.

**Test quality**

- The `gmail.test.ts` snapshot assertion (`toEqual([...])`) will correctly reflect the filter-based uncommitted implementation since `--hook-url` and its value are also stripped.
- The `server-methods.test.ts` test exercises the right scenario: it proves the output layer redaction catches secrets that somehow made it into the log file. This is a good regression anchor.
- There are no tests for the path where the file logger receives a secret-bearing log line (Remediation #2). This is acceptable given that path is out of scope for this fix, but it means the file-write surface is untested at the redaction boundary.

---

### Critical Issue

**`src/hooks/gmail.ts` has an uncommitted modification** (`M src/hooks/gmail.ts` in git status). The committed version on this branch adds `buildGogWatchServeLogArgs` as an inline arg builder (no sensitive flags included). The **current working tree** refactors it to the filter-based approach using `GMAIL_WATCH_SENSITIVE_FLAGS`. This is a meaningful behavioral difference:

- The committed inline approach: `--hook-url` and its value are absent from the log output (not listed at all).
- The filter approach: `--hook-url` and its value are explicitly removed. Same net result, but the constant `GMAIL_WATCH_SENSITIVE_FLAGS` is the canonical contract for what is considered sensitive.

The uncommitted state is the **better implementation**, but it must be committed before this branch can land. The branch is not in a shippable state as-is.

---

### Minor Issues

1. **`--hook-url` omission from existing tests**: The test in `gmail.test.ts` asserts the exact output matches a list that does not include `--hook-url`. This works correctly with the filter approach since `--hook-url` is in the sensitive set, but a comment explaining why `--hook-url` is omitted would aid future readers.
2. **Log file on disk retains secrets**: As noted, Remediation #2 (redact before file writes) is not implemented. Existing log files that predate this fix will still contain exposed credentials. Token rotation guidance or a changelog note about rotating tokens after upgrading would be appropriate.
3. **`getDefaultRedactPatterns()` call site in `log-tail.ts`**: Called inside the `.map()` callback. If this function recompiles regex patterns each invocation, it is wasteful. Should be pulled to a constant outside the map.

---

### Summary

The branch correctly targets a high-severity credential disclosure vulnerability. The defense-in-depth layering is well-structured and the test coverage covers the key regression scenarios. The **one blocking issue** is the uncommitted modification in `src/hooks/gmail.ts` — the filter-based refactor must be committed before landing. Once committed, this branch appears ready for review.

[CLAUDE PLAN]

## Source

GHSA-rw2r-3f8f-c5q8 — NVIDIA-dev/openclaw-tracking#364 — PR openclaw/openclaw#62661 (`logging-redaction` branch)

---

## Issues Found

### 1. BLOCKING — Uncommitted refactor in `src/hooks/gmail.ts`

The working tree already contains the correct implementation (`GMAIL_WATCH_SENSITIVE_FLAGS` + filter-based `buildGogWatchServeLogArgs`) but it has not been committed. The branch is not in a shippable state without this commit. This is also the exact change Greptile's P2 suggestion requests — the two findings are the same issue.

**Fix:** Commit the current working-tree state of `src/hooks/gmail.ts`. No code changes needed — the implementation is already correct.

### 2. MINOR — `getDefaultRedactPatterns()` allocated inside `.map()` in `src/logging/log-tail.ts:165-169`

`getDefaultRedactPatterns()` returns a new array copy on every invocation, and `resolvePatterns()` inside `redactSensitiveText` recompiles each of the ~18 pattern strings into a `RegExp` per call. With up to 5000 lines per `logs.tail` call, this creates up to ~90,000 regex compilations. The array should be allocated once outside the `.map()`.

**Fix:** In `readConfiguredLogTail()`, extract `getDefaultRedactPatterns()` to a `const` before the `lines:` map:

```typescript
const redactPatterns = getDefaultRedactPatterns();
lines: result.lines.map((line) =>
  redactSensitiveText(line, { mode: "tools", patterns: redactPatterns }),
),
```

### 3. MINOR — Missing comment in `src/hooks/gmail.test.ts:95-110` explaining absent flags

The `toEqual` snapshot for `buildGogWatchServeLogArgs` omits `--hook-url` and its value without explanation. A reader unfamiliar with `GMAIL_WATCH_SENSITIVE_FLAGS` will not know why the flag is absent.

**Fix:** Add a one-line comment above the `toEqual` assertion, e.g.:

```typescript
// --token, --hook-url, and --hook-token are stripped by GMAIL_WATCH_SENSITIVE_FLAGS
```

---

## Hidden Problem Assessment

No larger hidden problem exists beyond the documented known gap. All three exposure vectors in the original GHSA are addressed:

- **Source layer** (`gmail.ts` / `gmail-watcher.ts` / `gmail-ops.ts`): Both call sites log via `buildGogWatchServeLogArgs`, preventing secrets from entering the log file going forward.
- **Pattern layer** (`redact.ts:21`): `hook[-_]?token` is now in `DEFAULT_REDACT_PATTERNS`, so `--hook-token` values are caught by any caller of `redactSensitiveText`.
- **Output layer** (`log-tail.ts:165-169`): `readConfiguredLogTail` applies redaction before returning lines to `logs.tail` clients, catching any secrets that survived earlier layers.

**Known gap (out of scope):** The file logger (`src/logging/subsystem.ts`) does not apply `redactSensitiveText()` before disk writes (Remediation #2 from the issue). Log files written before this fix retain raw credentials on disk. This is explicitly framed as "defense in depth" in the issue and is not a regression introduced by this branch. Token rotation guidance in the changelog or advisory would be appropriate.

---

## Action Items (ordered)

1. **Commit `src/hooks/gmail.ts`** — the filter-based refactor is already in the working tree and correct; just needs `scripts/committer "fix(logging): use filter-based approach for gmail watch serve log args" src/hooks/gmail.ts`.
2. **Fix `log-tail.ts:165-169`** — pull `getDefaultRedactPatterns()` outside the `.map()` call.
3. **Add comment in `gmail.test.ts:94`** — clarify that `--hook-url` is absent because it is in `GMAIL_WATCH_SENSITIVE_FLAGS`.
4. **No action** on Remediation #2 (file logger redaction) — explicitly out of scope for this fix per the issue's framing.

[CODEX SUMMARY]

- Read NVIDIA-dev/openclaw-tracking#364 and matched the branch work against Claude's plan.
- Kept the existing uncommitted `src/hooks/gmail.ts` filter-based `buildGogWatchServeLogArgs()` implementation, which strips `--token`, `--hook-url`, and `--hook-token` plus their values from logged argv output.
- Updated `src/logging/log-tail.ts` to allocate `getDefaultRedactPatterns()` once per `readConfiguredLogTail()` call instead of once per line during `logs.tail` redaction.
- Added a clarifying comment in `src/hooks/gmail.test.ts` explaining why `--hook-url` is absent from the expected safe log argv.
- Ran targeted validation for the touched areas after the edits.

[CODEX]

Resolved the remaining open PR feedback on the `logs.tail` redaction path.

- Updated `src/logging/log-tail.ts` to resolve redaction settings once per request and reuse them for every returned line.
- Refactored `src/logging/redact.ts` so resolved redaction options can reuse compiled regex patterns instead of recompiling per line.
- Added `src/logging/log-tail.test.ts` to lock in that `readConfiguredLogTail()` uses one resolved redaction config for the whole response.
- Re-ran targeted tests for `src/logging/redact.test.ts`, `src/logging/log-tail.test.ts`, `src/gateway/server-methods/server-methods.test.ts`, and `src/hooks/gmail.test.ts`.

[CODEX]

Resolved the remaining live Codex review thread on `src/logging/redact.ts`.

- Updated `src/logging/redact.ts` so `resolveRedactOptions()` short-circuits when `logging.redactSensitive` is `off`, avoiding any pattern resolution or regex compilation on disabled paths.
- Added a regression in `src/logging/redact.test.ts` that would fail if pattern access still happens while redaction is off.
- Re-ran targeted tests for `src/logging/redact.test.ts`, `src/logging/log-tail.test.ts`, `src/gateway/server-methods/server-methods.test.ts`, and `src/hooks/gmail.test.ts`.
