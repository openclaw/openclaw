# RTK Integration Plan — Compact Output for Exec Tool

## Summary

Integrate [rtk](https://github.com/rtk-ai/rtk) as an optional output compressor for the `exec` tool. When `rtk` is detected in PATH, commands are transparently rewritten via `rtk rewrite "<cmd>"` to produce compressed output (60–90% token savings). The rewrite happens **after** all security/approval checks and **before** process spawn, affecting only gateway-hosted exec.

---

## Architecture

```
User command → security checks → approval → [RTK REWRITE] → runExecProcess() → output
                                                ↑
                                          New integration point
```

**Key principle:** The original command is preserved for display, logging, sessions, and security. Only the `execCommand` parameter (already supported by `runExecProcess`) is overridden with the rtk-rewritten variant.

---

## Files to Modify

### 1. `src/agents/bash-tools.exec.ts` — Integration Point

**Location:** Lines ~455–471, between `processGatewayAllowlist` result handling and `runExecProcess()` call.

**Changes:**

```typescript
// After line 455 (execCommandOverride = gatewayResult.execCommandOverride;)
// and after the validateScriptFileForShellBleed call (line 469),
// but BEFORE runExecProcess (line 471):

// --- NEW: rtk compact output rewrite ---
if (host === "gateway" && !elevatedRequested && defaults?.compactOutput !== "off") {
  const rtkRewrite = await tryRtkRewrite(params.command);
  if (rtkRewrite) {
    execCommandOverride = rtkRewrite;
  }
}
```

**Import addition** (top of file):

```typescript
import { tryRtkRewrite, initRtkDetection } from "./rtk-rewrite.js";
```

**In `createExecTool`**, add one-time detection call near the top of the factory (after defaults are processed, ~line 155):

```typescript
// Trigger async rtk detection on tool creation (cached)
initRtkDetection();
```

**Read `compactOutput` from defaults** — add to `ExecToolDefaults` passthrough in `pi-tools.ts`.

### 2. `src/agents/rtk-rewrite.ts` — NEW FILE

Create a new module with the rtk detection and rewrite logic:

```typescript
import { execSync } from "node:child_process";
import { logInfo, logWarn } from "../logger.js";

let rtkAvailable: boolean | null = null;
let rtkDetectionPromise: Promise<boolean> | null = null;

/**
 * Detect if rtk is available in PATH. Result is cached for process lifetime.
 */
export function initRtkDetection(): void {
  if (rtkDetectionPromise) return;
  rtkDetectionPromise = detectRtk();
}

async function detectRtk(): Promise<boolean> {
  try {
    execSync("rtk --version", {
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env },
    });
    rtkAvailable = true;
    logInfo("exec: rtk detected — compact output enabled");
    return true;
  } catch {
    rtkAvailable = false;
    return false;
  }
}

/**
 * Check if rtk is available (non-blocking after init).
 */
async function isRtkAvailable(): Promise<boolean> {
  if (rtkAvailable !== null) return rtkAvailable;
  if (rtkDetectionPromise) return rtkDetectionPromise;
  initRtkDetection();
  return rtkDetectionPromise!;
}

/**
 * Attempt to rewrite a command via rtk. Returns the rewritten command
 * string if rtk can compress it, or null if no rewrite is needed.
 *
 * Must only be called AFTER all security checks have passed.
 */
export async function tryRtkRewrite(command: string): Promise<string | null> {
  if (!(await isRtkAvailable())) return null;

  try {
    const result = execSync(`rtk rewrite ${JSON.stringify(command)}`, {
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env },
    });
    const rewritten = result.toString().trim();
    if (rewritten && rewritten !== command) {
      return rewritten;
    }
    return null;
  } catch {
    // Exit code 1 = no rewrite needed, other errors = skip silently
    return null;
  }
}

/** Reset cached detection (for testing). */
export function resetRtkDetection(): void {
  rtkAvailable = null;
  rtkDetectionPromise = null;
}
```

### 3. `src/agents/bash-tools.exec-types.ts` — Add Config Field

Add to `ExecToolDefaults`:

```typescript
/** Compact output mode: "auto" (use rtk if found), "off" (disable). Default: "auto". */
compactOutput?: "auto" | "off";
```

### 4. `src/config/types.tools.ts` — Config Schema

Add to `ExecToolConfig`:

```typescript
/**
 * Compact output compression via rtk.
 * - "auto" (default): use rtk if detected in PATH
 * - "off": disable rtk rewriting
 */
compactOutput?: "auto" | "off";
```

### 5. `src/agents/pi-tools.ts` — Wire Config Through

**Location:** ~line 394, in the `createExecTool({...})` call.

Add:

```typescript
compactOutput: options?.exec?.compactOutput ?? execConfig.compactOutput,
```

### 6. `src/config/schema.ts` or relevant Zod schema — Add Validation

Add `compactOutput` to the exec tool config schema validation (if Zod/TypeBox schema exists for `ExecToolConfig`). The field is a simple string enum `"auto" | "off"`.

---

## Integration Point — Exact Location

**File:** `src/agents/bash-tools.exec.ts`
**Function:** `createExecTool()` → `execute()` callback
**Line:** Between line 469 (`validateScriptFileForShellBleed`) and line 471 (`runExecProcess`)

```
Line 455: execCommandOverride = gatewayResult.execCommandOverride;
Line 456: }  // end of gateway allowlist block
...
Line 469: await validateScriptFileForShellBleed({ command: params.command, workdir });
          ← INSERT RTK REWRITE HERE (lines ~470)
Line 471: const run = await runExecProcess({
Line 473:   execCommand: execCommandOverride,  ← this carries the rewritten command
```

**Why this exact point:**

- Security checks (allowlist, approval, elevated) are complete ✅
- `execCommandOverride` is already used by the safeBins system for the same pattern ✅
- The original `params.command` is preserved for display/logging ✅
- `runExecProcess` already accepts `execCommand` as separate from `command` ✅
- Only gateway host reaches this code path (node returns earlier, sandbox uses docker) ✅

---

## Guard Conditions

The rtk rewrite is gated by ALL of:

1. **`host === "gateway"`** — skip for sandbox (docker) and node
2. **`!elevatedRequested`** — skip for elevated/sudo commands
3. **`defaults?.compactOutput !== "off"`** — respect user opt-out
4. **`rtkAvailable === true`** — rtk binary detected in PATH
5. **`rtk rewrite` exits 0** — rtk confirms the command can be compressed

---

## Config Schema Change

```yaml
# openclaw.json
{
  "tools": {
    "exec": {
      "compactOutput": "auto"  // or "off"
    }
  }
}
```

Default: `"auto"` — rtk is used if detected, silently skipped if not.

---

## Existing Pattern Leveraged

The `execCommandOverride` mechanism already exists for safeBins rewrites via `processGatewayAllowlist()`:

```typescript
// Line 455 — existing pattern
execCommandOverride = gatewayResult.execCommandOverride;

// Line 473 — already consumed by runExecProcess
execCommand: execCommandOverride,
```

The rtk integration reuses this exact mechanism. If safeBins already set an `execCommandOverride`, rtk rewrites THAT (the already-sanitized command), not the original. This is correct because:

- SafeBins rewrites are for security (path resolution)
- RTK rewrites are for output compression
- Both are transparent to the user

**Handling both:** If `execCommandOverride` is already set by safeBins, rtk should rewrite THAT command:

```typescript
const commandToRewrite = execCommandOverride ?? params.command;
const rtkRewrite = await tryRtkRewrite(commandToRewrite);
if (rtkRewrite) {
  execCommandOverride = rtkRewrite;
}
```

---

## Test Plan

### Unit Tests — `src/agents/rtk-rewrite.test.ts` (NEW)

1. **`detectRtk` — binary found:** Mock `execSync` returning version → `isRtkAvailable()` returns true
2. **`detectRtk` — binary not found:** Mock `execSync` throwing → `isRtkAvailable()` returns false
3. **`tryRtkRewrite` — successful rewrite:** Mock returning rewritten command → returns rewritten string
4. **`tryRtkRewrite` — no rewrite needed:** Mock exit code 1 → returns null
5. **`tryRtkRewrite` — rtk not available:** Returns null without calling execSync
6. **`tryRtkRewrite` — timeout:** Mock timeout → returns null (graceful degradation)
7. **`resetRtkDetection`** — clears cache, re-detection works

### Integration Tests — `src/agents/bash-tools.exec.rtk.test.ts` (NEW)

1. **Gateway + rtk available:** Verify `execCommand` passed to `runExecProcess` is the rewritten version
2. **Gateway + rtk unavailable:** Verify original command flows through unchanged
3. **Gateway + compactOutput="off":** Verify rtk is never called
4. **Sandbox host:** Verify rtk rewrite is skipped entirely
5. **Node host:** Verify rtk rewrite is skipped entirely
6. **Elevated command:** Verify rtk rewrite is skipped
7. **SafeBins + rtk:** Verify rtk rewrites the safeBins-resolved command

### Existing Tests

**No modifications needed.** The integration:

- Adds a new code path that defaults to no-op when rtk is absent
- Does not change any function signatures
- Does not modify security/approval flow
- Preserves `params.command` for all display/logging/session purposes

---

## Risk Assessment

### Low Risk

- **Opt-out by default behavior:** If `rtk` isn't installed, zero code paths change. All existing tests pass unchanged.
- **Uses existing `execCommandOverride` pattern:** No new plumbing — same mechanism safeBins uses.
- **No security surface change:** Rewrite happens after ALL security gates. The original command is what gets approved; the rewrite only changes how output is formatted.
- **Graceful degradation:** Any `rtk` failure (timeout, crash, exit 1) silently falls back to original command.

### Medium Risk

- **`execSync` in hot path:** The `rtk rewrite` call is synchronous and blocks the event loop for up to 2s. Mitigation: rtk is a compiled Rust binary; `rewrite` is a string-only operation that should complete in <10ms. The 2s timeout is a safety net.
- **Shell injection via `rtk rewrite` argument:** The command string is passed via `JSON.stringify()` which handles quoting. However, this creates a shell-in-shell scenario. **Alternative:** Use `execFileSync("rtk", ["rewrite", command])` to avoid shell interpretation entirely — **recommended.**

### Mitigations

1. **Use `execFileSync` instead of `execSync`** for the rewrite call:

   ```typescript
   import { execFileSync } from "node:child_process";
   const result = execFileSync("rtk", ["rewrite", command], {
     timeout: 2000,
     stdio: ["ignore", "pipe", "ignore"],
   });
   ```

   This avoids any shell metacharacter issues.

2. **Detection uses `execFileSync("rtk", ["--version"])`** — same pattern, no shell.

3. **Consider async `execFile`** instead of sync variants to avoid blocking the event loop, especially if multiple exec tool calls run concurrently. The overhead is minimal but it's cleaner:
   ```typescript
   import { execFile } from "node:child_process";
   import { promisify } from "node:util";
   const execFileAsync = promisify(execFile);
   ```

---

## File Summary

| File                                  | Action     | Changes                                                     |
| ------------------------------------- | ---------- | ----------------------------------------------------------- |
| `src/agents/rtk-rewrite.ts`           | **CREATE** | Detection + rewrite logic (~60 lines)                       |
| `src/agents/rtk-rewrite.test.ts`      | **CREATE** | Unit tests (~80 lines)                                      |
| `src/agents/bash-tools.exec.ts`       | **MODIFY** | Add import + 6-line rewrite block before `runExecProcess()` |
| `src/agents/bash-tools.exec-types.ts` | **MODIFY** | Add `compactOutput` field to `ExecToolDefaults`             |
| `src/config/types.tools.ts`           | **MODIFY** | Add `compactOutput` field to `ExecToolConfig`               |
| `src/agents/pi-tools.ts`              | **MODIFY** | Wire `compactOutput` config through to `createExecTool()`   |
| Config schema validation              | **MODIFY** | Add `compactOutput` enum validation (1 line)                |

**Total footprint:** ~1 new file (60 LOC) + ~5 lines changed across 4 existing files.

---

## Implementation Order

1. Create `src/agents/rtk-rewrite.ts` with detection + rewrite + tests
2. Add `compactOutput` to `ExecToolConfig` and `ExecToolDefaults` types
3. Wire config through `pi-tools.ts`
4. Add the 6-line rewrite block in `bash-tools.exec.ts`
5. Add schema validation for the new config field
6. Write integration tests
7. Run full test suite — confirm zero regressions
