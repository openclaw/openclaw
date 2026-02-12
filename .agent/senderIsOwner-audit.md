# senderIsOwner Audit Report

**Task 2.1 - Audit complete**
**Date:** 2026-02-12

## Summary

`senderIsOwner` is a boolean flag used to grant OWNER-level permissions for internal runtime calls (cron, CLI) and user commands from owner whitelist. It has two primary use cases:

1. **User-initiated commands** — set by command-auth based on owner whitelist
2. **Internal runtime calls** — hardcoded to `true` for cron jobs and CLI invocations

## Key Locations

### 1. Definition & Assignment

| File                             | Line | Purpose                                                                                              |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `src/auto-reply/command-auth.ts` | 293  | `senderIsOwner = Boolean(matchedSender)` — checks if sender matches owner whitelist                  |
| `src/cron/isolated-agent/run.ts` | 417  | `senderIsOwner: true` — hardcoded for cron jobs (comment: "Heimdall: cron jobs always run as OWNER") |
| `src/commands/agent.ts`          | 431  | `senderIsOwner: true` — hardcoded for CLI agent invocations                                          |

### 2. Pass-through Chain

| File                                    | Line     | Purpose                                                |
| --------------------------------------- | -------- | ------------------------------------------------------ |
| `src/auto-reply/reply/get-reply-run.ts` | 423      | Passes `command.senderIsOwner` to agent runner options |
| Various runner/compact files            | Multiple | Propagates through agent execution pipeline            |

### 3. Consumption Sites

| File                        | Line    | Purpose                                                                               | Action Needed                |
| --------------------------- | ------- | ------------------------------------------------------------------------------------- | ---------------------------- |
| `src/agents/pi-tools.ts`    | 366     | Reads `options?.senderIsOwner === true`                                               | Replace with `internal` flag |
| `src/agents/pi-tools.ts`    | 379-382 | **CRITICAL WORKAROUND** — overrides tier to OWNER when senderIsOwner=true             | **REMOVE in Task 2.3**       |
| `src/agents/tool-policy.ts` | 91      | Legacy `applyOwnerOnlyToolPolicy(tools, senderIsOwner)` — pre-Heimdall tool filtering | Consider deprecation         |

## Critical Finding: The Workaround (pi-tools.ts:379-382)

```typescript
// Override to OWNER if senderIsOwner is explicitly set (cron, CLI).
if (senderIsOwner && senderTier !== "owner") {
  senderTier = "owner" as SenderTier;
}
```

**Why this exists:** Before SYSTEM tier, cron/CLI calls would fall into GUEST (blocked). This workaround grants OWNER tier to bypass restrictions.

**Why it must be removed:** Violates least privilege principle. SYSTEM tier provides proper solution.

## Semantics

`senderIsOwner` conflates two distinct concepts:

1. **User is in owner whitelist** (authorization decision)
2. **Call is internal runtime operation** (provenance signal)

For internal calls (cron, CLI), we need provenance (`isTrustedInternal`), not authorization (`senderIsOwner`).

## Replacement Strategy (Task 2.2)

1. Add new `internal?: boolean` option to agent runner options
2. Set `internal: true` at call sites (cron, CLI)
3. Map `internal` → `isTrustedInternal` parameter when calling `resolveSenderTier()`
4. Remove workaround lines 379-382
5. Keep `senderIsOwner` for user command authorization (command-auth.ts use case)

## Testing Implications

Must verify after replacement:

- Cron jobs → SYSTEM tier (not OWNER)
- CLI invocations → SYSTEM tier (not OWNER)
- User commands from owner whitelist → OWNER tier (unchanged)
- SYSTEM tier has minimal permissions (conservative safe list)
- No regression in command authorization logic

## Files to Modify in Task 2.2

1. `src/cron/isolated-agent/run.ts:417` — change `senderIsOwner: true` → `internal: true`
2. `src/commands/agent.ts:431` — change `senderIsOwner: true` → `internal: true`
3. `src/agents/pi-tools.ts:366-383` — read `internal` flag, map to `isTrustedInternal`, remove workaround
4. Type definitions — add `internal?: boolean` to AgentRunnerOptions
