WORK LOG

Add your findings and worklogs by appending to the end of this file. Do not overwrite anything that is existing in this file. Write with the format being used.

[CODEX]

I've brought work into the workstream.

[CLAUDE]

I've assigned the work to eleqtrizit.

[CLAUDE REVIEW]

## Branch: `logging-redaction` — Security Fix Review

### Tracking Issue

NVIDIA-dev/openclaw-tracking#364 — GHSA-rw2r-3f8f-c5q8 (severity: high)

---

### What Is This Branch Trying to Accomplish?

This branch patches a credential-disclosure vulnerability where an `operator.read`-scoped gateway client could recover reusable hook credentials (`hookToken`, `pushToken`) by calling `logs.tail`. The exploit chain was:

1. Gmail watcher startup code built a full `gog gmail watch serve` argv string — including `--token <pushToken>` and `--hook-token <hookToken>` — and logged it verbatim before spawning the process.
2. The file logger wrote that line to disk without any redaction pass.
3. The `logs.tail` gateway method returned raw file lines and is scoped to `operator.read` (not write).
4. The `hookToken` is accepted as a valid bearer token on hook ingress (`POST /hooks/agent`), so disclosure → direct write-path replay.

The result is that a read-only client could obtain write-capable credentials — the same class of bug as prior advisories GHSA-8mh7-phf8-xgfm and GHSA-ppwq-6v66-5m6j.

---

### What the Branch Does (commit by commit)

**78a644bbeb** — `fix(logging): redact gmail watcher startup args`

- Adds `GMAIL_WATCH_SENSITIVE_FLAGS = new Set(["--token", "--hook-url", "--hook-token"])` in `src/hooks/gmail.ts`.
- Adds `buildGogWatchServeLogArgs(cfg)` which filters out both the sensitive flag and its following value using array index look-back.
- Both `src/hooks/gmail-watcher.ts` and `src/hooks/gmail-ops.ts` switch from logging raw `args.join(" ")` to logging `buildGogWatchServeLogArgs(cfg).join(" ")`.

**c1561e43a4** — `fix(logging): normalize redaction formatting`

- Introduces `ResolvedRedactOptions` (typed `{ mode, patterns: RegExp[] }`) to distinguish resolved from unresolved options.
- Exports new `resolveRedactOptions()` function so callers can resolve once and reuse across many lines.
- Extends `parsePattern()` to accept `RegExp` directly (not just `string`), with automatic `g` flag addition when absent.
- Refactors `redactSensitiveText()` internally to delegate to `resolveRedactOptions()`.

**bd4cc1f190** — `fix(logging): harden gmail watcher log redaction`

- Widens the CLI flag redaction pattern from `--(?:api[-_]?key|token|secret|password|passwd)` to `--(?:api[-_]?key|hook[-_]?token|token|secret|password|passwd)`, catching `--hook-token` and `--hook_token` variants.
- Adds a unit test proving the new pattern redacts `--hook-token` values.

**92584fe167** — `fix(logging): honor configured log tail redaction`

- Modifies `readConfiguredLogTail()` in `src/logging/log-tail.ts` to call `resolveRedactOptions()` once and then map it over every returned line with `redactSensitiveText(line, redaction)`.
- This makes the `logs.tail` API path a final defense layer regardless of what upstream callers logged.

**2ff95dd883** — `fix(logging): skip redact pattern resolution when off`

- Makes `resolveRedactOptions()` short-circuit and return `{ mode: "off", patterns: [] }` when mode is `"off"`, avoiding unnecessary pattern compilation.
- Adds a test using a getter trap to prove `patterns` is never accessed when mode is off.

---

### Defense-in-Depth Assessment

The fix applies three distinct protection layers, which directly addresses the advisory's remediation guidance:

| Layer                   | Location                                 | Approach                                              | Status      |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------- | ----------- |
| 1. Source suppression   | `src/hooks/gmail.ts` + callers           | Strip secrets from logged argv before `log.info()`    | ✅ Done     |
| 2. Pattern matching     | `src/logging/redact.ts`                  | `--hook-token` added to CLI flag regex                | ✅ Done     |
| 3. API egress redaction | `src/logging/log-tail.ts`                | Redact every returned line in `readConfiguredLogTail` | ✅ Done     |
| 4. File-write redaction | `src/logging/subsystem.ts` / `logger.ts` | Apply `redactSensitiveText` before writing to disk    | ❌ Not done |

The advisory's remediation step 2 (apply redaction at the logger transport/file-write layer) is **not implemented**. This is a deliberate trade-off — the primary attack vector (the `logs.tail` API) is now fully defended, and the upstream source fix (layer 1) means secrets won't reach the log file from this path. However, the log file on disk **still contains the pre-fix history** until rotated, and any other code path that logs secrets without sanitizing would also persist them to disk unredacted. If the log file is accessible via backup, direct SSH read, or a future read path, those secrets remain exposed.

This gap is not a regression from the current branch — it's a pre-existing architectural property — but it's worth tracking as a follow-up.

---

### Code Quality

**Strengths:**

- `GMAIL_WATCH_SENSITIVE_FLAGS` as a `Set` is idiomatic and correct. The filter logic using `args[index - 1] ?? ""` correctly strips both the flag and its value in one pass.
- `ResolvedRedactOptions` as a distinct type from `RedactOptions` is a clean separation. It makes the resolved/unresolved distinction explicit and prevents callers from accidentally passing unresolved options where compiled patterns are needed.
- `resolveRedactOptions()` is called **once** before the `lines.map(...)` in `readConfiguredLogTail`, not N times per line. This is correct for performance and for consistency (same config snapshot applied to all lines).
- The `RegExp` support in `parsePattern` is well-guarded: it clones the regex with `g` flag if absent, rather than mutating the input.
- Early exit in `resolveRedactOptions` when `mode === "off"` avoids pattern compilation entirely.
- Both `gmail-watcher.ts` and `gmail-ops.ts` are patched — the fix does not miss the second caller of `spawnGogServe`.

**Minor concerns:**

- `--hook-url` is included in `GMAIL_WATCH_SENSITIVE_FLAGS`. The hook URL (`http://127.0.0.1:18789/hooks/gmail`) is not a credential, but stripping it from logs is conservative and fine. However, it is **not** added to the redact pattern in `redact.ts`. This is consistent (URLs are not secrets) but means if a hook URL with embedded secrets were logged elsewhere, the pattern wouldn't catch it. Not a bug here, just worth noting for completeness.
- `buildGogWatchServeLogArgs` is a parallel function to `buildGogWatchServeArgs` rather than a parameter to it. This is reasonable for clarity, but a future addition of a new secret flag to `buildGogWatchServeArgs` requires a matching update to `GMAIL_WATCH_SENSITIVE_FLAGS`. There's no compile-time enforcement of this coupling. A comment on `buildGogWatchServeArgs` pointing at the set would help future maintainers.
- `log-tail.test.ts` imports `readConfiguredLogTail` via `await import(...)` inside the test body (to pick up the module mock). Since there is only one test in the describe block, this works, but if more tests are added they should use `beforeAll` for the import per the repo's test performance guardrails.

---

### Test Coverage

| Test                                                    | File                                                | What it proves                                                                                                             |
| ------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `builds watch serve log args without secrets`           | `src/hooks/gmail.test.ts`                           | `buildGogWatchServeLogArgs` strips `--token`, `--hook-url`, `--hook-token` and their values; exact remaining args asserted |
| `masks hook token CLI flags`                            | `src/logging/redact.test.ts`                        | Default pattern catches `--hook-token <value>` and redacts it                                                              |
| `does not resolve patterns when mode is off`            | `src/logging/redact.test.ts`                        | `resolveRedactOptions` short-circuits; getter trap proves `patterns` not accessed                                          |
| `reuses resolved redaction settings for returned lines` | `src/logging/log-tail.test.ts`                      | `resolveRedactOptions` called once; each line passed to `redactSensitiveText` with the same resolved options               |
| `redacts sensitive CLI tokens from returned lines`      | `src/gateway/server-methods/server-methods.test.ts` | End-to-end: `logs.tail` handler returns redacted lines from a file containing raw token values                             |

Coverage is solid. The integration test in `server-methods.test.ts` is especially valuable — it tests the full stack from file content to API response without mocking the redaction logic.

---

### Standards Compliance

- TypeScript strict: no `any` introduced; new types are precise.
- No inline lint suppressions.
- Tests use `vi.hoisted()` correctly for mock initialization order.
- Commits are atomic, scoped, and action-oriented (`fix(logging): ...`).
- No changelog entry added (pure internal security fix, which is standard for GHSA patches that go through a coordinated advisory).
- File sizes remain well within the ~700 LOC guideline.

---

### Summary

The branch correctly identifies and closes the primary attack vector: `logs.tail` no longer returns raw hook credentials. The layered approach (source suppression + pattern widening + egress redaction) is solid and follows the advisory's own remediation guidance for layers 1, 3, and 4. The one gap is that log file contents on disk are not sanitized at write time (advisory remediation step 2), which leaves historical log entries exposed if the file is accessed outside `logs.tail`. This is a known and acceptable trade-off given the primary fix. Test coverage is thorough at unit, integration, and end-to-end levels. No standards violations found.

---

[CLAUDE PLAN]

## Review Comment Analysis — openclaw/openclaw#62661 / NVIDIA-dev/openclaw-tracking#364

### Triage of All Review Comments

| Source   | Priority | Location                     | Finding                                                                                                                                                                                                                                                       | Status                                                                                                                                                               |
| -------- | -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Greptile | P2       | `src/hooks/gmail.ts:253-274` | `buildGogWatchServeLogArgs` was a duplicate of non-sensitive flags and would drift from `buildGogWatchServeArgs` when new flags are added                                                                                                                     | **Already resolved** — current code (line 254-260) derives by filtering `buildGogWatchServeArgs`                                                                     |
| Codex    | P1       | `src/logging/log-tail.ts`    | `readConfiguredLogTail` hard-codes `mode: "tools"` and default patterns, bypassing user-configured `logging.redactPatterns`                                                                                                                                   | **Already resolved** — `resolveRedactOptions()` with no args calls `resolveConfigRedaction()` which reads from user config; comment is stale (reviewed `c1561e43a4`) |
| Codex    | P2       | `src/logging/log-tail.ts`    | `getDefaultRedactPatterns()` called per-line, `redactSensitiveText` reparses patterns on each invocation                                                                                                                                                      | **Partially resolved, one path still re-compiles** — see real P2 below                                                                                               |
| Codex    | P2       | `src/logging/redact.ts:147`  | `resolveRedactOptions` compiles patterns before the mode check when mode is `off`                                                                                                                                                                             | **Already resolved** — commit `2ff95dd883` short-circuits before `resolvePatterns` when `mode === "off"`                                                             |
| Codex    | P2       | `src/logging/redact.ts:155`  | `readConfiguredLogTail` calls `resolveRedactOptions()` once, passes result to `redactSensitiveText(line, resolved)`, but `redactSensitiveText` calls `resolveRedactOptions(options)` again — re-running `resolvePatterns` and cloning every `RegExp` per line | **Real remaining issue — needs fix**                                                                                                                                 |
| Codex    | P2       | `USER.md:3`                  | Internal worklog/advisory tracking notes committed to source history                                                                                                                                                                                          | Informational — intentional worklog; no code change required                                                                                                         |

---

### Real Remaining Issue

**`parsePattern` clones `RegExp` objects that already have the `g` flag, causing per-line regex re-allocation in `logs.tail`.**

When `readConfiguredLogTail` calls:

```ts
const redaction = resolveRedactOptions(); // returns ResolvedRedactOptions { mode, patterns: RegExp[] }
lines: result.lines.map((line) => redactSensitiveText(line, redaction));
```

`redactSensitiveText(line, redaction)` calls `resolveRedactOptions(redaction)` internally (redact.ts:155), which calls `resolvePatterns(redaction.patterns)` on already-compiled `RegExp[]`, which maps each through `parsePattern`, which currently clones every `RegExp` (lines 58-61). For a 5000-line tail with N=17 patterns, that's 85,000 unnecessary regex object allocations per `logs.tail` call.

**Not a hidden larger problem** — checked that:

- No other `spawn`/`exec` call sites log raw sensitive args (`buildGogWatchServeLogArgs` is used correctly in both `gmail-watcher.ts:64` and `gmail-ops.ts:357`)
- No other channel/hook startup code has the same pattern
- `logs.tail` is the only read-scoped egress path for log content (confirmed in `method-scopes.ts`)

---

### Fix Plan

**File:** `src/logging/redact.ts`  
**Function:** `parsePattern` (lines 57-71)  
**Change:** Return a `RegExp` as-is if it already has the `g` flag, instead of cloning it.

```ts
// Before (lines 58-61):
if (raw instanceof RegExp) {
  const flags = raw.flags.includes("g") ? raw.flags : `${raw.flags}g`;
  return new RegExp(raw.source, flags);
}

// After:
if (raw instanceof RegExp) {
  if (raw.flags.includes("g")) return raw; // already global — no clone needed
  return new RegExp(raw.source, `${raw.flags}g`);
}
```

This is safe: `String.replace(globalRegex, ...)` resets `lastIndex` internally, so reusing the same `RegExp` object across calls is correct. The change is backward-compatible — behavior is identical, only allocation is eliminated.

**Tests:** No test changes required. Existing tests remain valid:

- `does not resolve patterns when mode is off` — unaffected (short-circuit before `resolvePatterns`)
- `reuses resolved redaction settings for returned lines` — unaffected (this test checks `resolveRedactOptions` call count, not `parsePattern` cloning)
- All other redact/log-tail tests — unaffected

**Verification gate:** `pnpm test src/logging/redact.test.ts src/logging/log-tail.test.ts` must pass. No build-output impact, so `pnpm build` is not required.

---

### Known Gap (Informational — No Action for This PR)

Layer 4 (file-write redaction): `src/logging/subsystem.ts` and `src/logging/logger.ts` do not apply `redactSensitiveText` before writing to disk. This means secrets logged before this fix was deployed remain on disk until log rotation. This is a pre-existing architectural property, not a regression from this branch, and is the remediation step 2 from the advisory. Recommend tracking as a follow-up issue rather than blocking this PR.

[CODEX SUMMARY]

- Read `USER.md` and NVIDIA-dev/openclaw-tracking#364 for branch and advisory context.
- Patched `src/logging/redact.ts` so `parsePattern()` reuses incoming `RegExp` objects that already include the `g` flag instead of cloning them again. This removes the remaining per-line regex allocation churn on the `logs.tail` redaction path while preserving behavior.
- Added a regression test in `src/logging/redact.test.ts` proving `resolveRedactOptions()` preserves compiled global regex instances.
- Verification:
  - `corepack pnpm test src/logging/redact.test.ts`
  - `corepack pnpm test src/logging/log-tail.test.ts`
