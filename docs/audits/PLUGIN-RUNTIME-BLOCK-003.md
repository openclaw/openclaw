# Audit: PLUGIN-RUNTIME-BLOCK-003 — Plugin Runtime Guard Enforcement

## Overview

**Objective:** Convert the existing logging-only PLUGIN-RUNTIME-002 guard into **enforcement mode**, so that `approval_required` and `deny` decisions actually block tool calls before they reach the backend.

**Status:** ✅ COMPLETE (2026-06-22 22:10 KST)

## Files Changed

| File                                              | Change                                                                    | Lines |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ----- |
| `src/plugins/plugin-runtime-guard.ts`             | Expanded with tool name pattern matching, cache, blocked result formatter | +112  |
| `src/agents/agent-bundle-mcp-materialize.ts`      | Added enforcement hook in `createExecute` chokepoint before `callTool`    | +21   |
| `src/plugins/plugin-runtime-guard.test.ts`        | Rewritten with BLOCK-003 test coverage                                    | 294   |
| `extensions/telegram/src/bot-message.ts`          | Comment update — pre-filter is logging-only                               | -2    |
| `extensions/telegram/src/bot-message-dispatch.ts` | Comment update — pre-filter is logging-only                               | -2    |

## Architecture: Enforcement Chokepoint

```
User Request
  ↓
bot-message.ts ─── pre-filter (logging-only, always "read")
  ↓
bot-message-dispatch.ts ─── pre-filter (logging-only, always "read")
  ↓
agent-bundle-mcp-materialize.ts ─── createExecute chokepoint ✅ REAL ENFORCEMENT
  ├─ decideToolCallCapabilityCached(tool.toolName) → PluginActionCapability[]
  ├─ guardPluginActionRuntime(guardDescriptor) → PluginActionRuntimeResult
  ├─ if !ok → formatBlockedResult() → controlled {content, details}
  └─ if ok  → runtime.callTool() → normal execution
```

## decideToolCallCapability — Pattern Matching

Patterns checked in **priority order** (most specific first):

| Priority | Pattern     | Mapping                | Example                                      |
| -------- | ----------- | ---------------------- | -------------------------------------------- |
| 1st      | Destructive | `destructive`          | `dropTable`, `purgeAllData`, `nukeDatabase`  |
| 2nd      | Financial   | `financial_execution`  | `buyStock`, `placeOrder`, `transferFunds`    |
| 3rd      | Send        | `send` + `write`       | `sendEmail`, `postMessage`, `broadcastAlert` |
| 4th      | Delete      | `delete` + `write`     | `deleteFile`, `removeUser`, `clearLogs`      |
| 5th      | Write       | `write`                | `createItem`, `updateRecord`, `setConfig`    |
| 6th      | Read        | `read`                 | `getItem`, `listTools`, `searchDoc`          |
| Default  | Unknown     | `write` (conservative) | `myFunction`, `customAction`                 |

CamelCase and snake_case variants both covered (e.g. `purgeAll`, `purge_all`, `purge-all`).

## Enforcement Behavior

| Capability            | Decision            | Tool Call Executed? | Result                                                 |
| --------------------- | ------------------- | ------------------- | ------------------------------------------------------ |
| `read`                | `allow`             | ✅ Yes              | Normal execution                                       |
| `write`               | `approval_required` | ❌ Blocked          | `"Action blocked by plugin policy: approval required"` |
| `send`                | `approval_required` | ❌ Blocked          | Same                                                   |
| `delete`              | `approval_required` | ❌ Blocked          | Same                                                   |
| `costly`              | `approval_required` | ❌ Blocked          | Same                                                   |
| `private_data`        | `approval_required` | ❌ Blocked          | Same                                                   |
| `secret_access`       | `approval_required` | ❌ Blocked          | Same                                                   |
| `financial_execution` | `deny`              | ❌ Blocked          | `"Action denied by plugin policy"`                     |
| `destructive`         | `deny`              | ❌ Blocked          | Same                                                   |
| `unknown` / empty     | `deny`              | ❌ Blocked          | Same                                                   |

## Verification

| Check                              | Result                                             |
| ---------------------------------- | -------------------------------------------------- |
| `plugin-runtime-guard.test.ts`     | **134/134 PASS**                                   |
| `agent-bundle-mcp-runtime.test.ts` | **26/26 PASS**                                     |
| `bot-message.test.ts`              | **35/35 PASS**                                     |
| `plugin-status-message.test.ts`    | **22/22 PASS**                                     |
| **Total**                          | **217/217 ALL PASS**                               |
| `pnpm run build`                   | ✅ 168.7s                                          |
| Gateway restart                    | ✅ PID 1637699, 22:16:26 ready                     |
| dist guard references              | ✅ 3 `Action blocked by plugin policy` in bundle   |
| conversation_logs                  | ✅ 1798 rows, logging at 22:17:14                  |
| forbidden files unchanged          | ✅ package.json/pnpm-lock.yaml/openclaw.json clean |

## PASS Condition Verification

1. ✅ `approval_required` → blocked before callTool
2. ✅ `deny` → blocked before callTool
3. ✅ `read allow` → normal execution
4. ✅ `private_data` → `approval_required` block
5. ✅ `unknown`/empty → `deny` block
6. ✅ blocked result → controlled text with no throw
7. ✅ gateway/agent no crash
8. ✅ selectedMcpServers lazy loading — untouched
9. ✅ `/mcp_status`, `/plugins` — untouched
10. ✅ 217/217 tests PASS
11. ✅ No package/lock/config/secrets/model/DB/MEMORY.md changes

## Remaining (v2 candidates)

- **Guard mode promotion from `"enforce"` default**: Already enforced. No config toggle needed for MVP.
- **Capability cache eviction policy**: Currently unbounded LRU (30 entries limit via cache size check in source). Real LRU eviction trivial to add.
- **User-facing approval flow**: Currently returns `approval_required` blocked text. A future version could send inline Telegram buttons for real-time approve/deny.
