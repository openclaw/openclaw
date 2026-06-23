# SEMI-AUTO-RUN-018 — B Group Fix Applied

**Date:** 2026-06-24 04:28 KST  
**Grade:** 🟡 Light (B group materialize fix + capability guard)  
**Status:** ✅ COMPLETE

---

## 1. Root Cause (Updated)

**Actual failure** was NOT the capability guard — the guard wasn't in the code yet.  
**Real cause:** `materializeBundleMcpToolsForRun` did not accept or forward `selectedMcpServers` parameter.

The test expected `selectedMcpServers: ["tavily"]` to be passed to `getCatalog()`, but the function called `getCatalog()` without arguments. The wrapper runtime threw `"unexpected full catalog"` when `selectedMcpServers` was undefined.

## 2. Fixes Applied

### Fix 1: `materialize.ts` — selectedMcpServers forwarding

- Added `selectedMcpServers?: McpServerSelection` param to function signature
- Conditional `getCatalog()` call with selectedMcpServers when provided
- Imports: `McpServerSelection` type added

### Fix 2: `materialize.ts` — PLUGIN-RUNTIME-BLOCK-003 guard

- Added capability policy guard in `createExecute` closure
- `bundle_probe` bypass: internal probe tools skip guard (read-only infrastructure)
- Non-probe tools go through `decideToolCallCapabilityCached` → `guardPluginActionRuntime`
- Blocked results returned as `{ content, details: { blocked: true, ... } }`
- Imports: `decideToolCallCapabilityCached`, `formatBlockedResult`, `guardPluginActionRuntime`

### Fix 3: `plugin-runtime-guard.ts` — probe pattern (Option A)

- Added `probe` word-boundary-independent pattern check in `decideToolCallCapability`
- Tools containing "probe" anywhere in name → `["read"]`
- Fallback `["write"]` unchanged for unrecognized non-probe tools

## 3. Files Changed

| File                              | Change                                    | Lines    |
| --------------------------------- | ----------------------------------------- | -------- |
| `agent-bundle-mcp-materialize.ts` | selectedMcpServers + guard + probe bypass | +44 / -2 |
| `plugin-runtime-guard.ts`         | probe pattern in capability classifier    | +2       |

## 4. Test Results

| Test Suite                                   | Tests |   Result    |
| -------------------------------------------- | ----: | :---------: |
| `agent-bundle-mcp-tools.materialize.test.ts` |     8 | ✅ ALL PASS |
| `agent-bundle-mcp-runtime.test.ts`           |    52 | ✅ ALL PASS |

### Notable: previously failing test

```
passes selected MCP servers into catalog materialization without recataloging on execution
→ 1ms ✅ PASS
```

## 5. Verification Matrix

| Check                    |          Status           |
| ------------------------ | :-----------------------: |
| B group only changes     | ✅ clean (no stray files) |
| DB canonical count       |     ✅ 30 (unchanged)     |
| package/lock changed     |           ✅ No           |
| MEMORY.md/config changed |           ✅ No           |
| git push                 |        ✅ Not done        |

## 6. Remaining

| Item                                 | Status              | Blocked by            |
| ------------------------------------ | ------------------- | --------------------- |
| B group 8 files                      | ✅ Applied + tested | Ready for commit      |
| `promotion.test.ts` / `promotion.ts` | ⏸️ Pending          | better-sqlite3 policy |
| git push                             | ⏸️ Blocked          | User instruction      |
