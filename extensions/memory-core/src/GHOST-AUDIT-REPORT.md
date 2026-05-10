# Ghost Security Audit — Bug #65374 (bugfix/65374-agent-isolation)

**Branch:** `bugfix/65374-agent-isolation`  
**Commits:** bd829020 → 185c7e14 (8 commits)  
**Auditor:** Ghost  
**Date:** 2026-05-02  
**Status:** AUDIT COMPLETE — 4/4 targets assessed, 1 gap found and fixed, 3 non-blocking findings

---

## Executive Summary

The three-layer fix for Bug #65374 is well-architected and correctly implemented. The core isolation logic (Layer 2) is sound: `currentAgentId` is threaded from `ctx.agentId` through the full dreaming pipeline, and the fail-closed check at `dreaming-phases.ts:721` handles undefined, empty, and whitespace-only values correctly. Per-agent corpus files (Layer 2c) and provenance sidecar (Layer 3) are implemented as designed. All 62 tests pass.

**One gap found during audit:** whitespace-only `currentAgentId` bypassed the original fail-closed check (commit aad87c3b). Fixed before audit completion. No other actionable findings.

---

## Target Assessment

### (a) Bypass currentAgentId filtering via config manipulation

**Finding:** The `currentAgentId` derivation uses a trust-on-first-use model.

**How it works:**

- `ctx.agentId` comes from `resolveRunWorkspaceDir()` in `workspace-run.ts`
- Derivation hierarchy: explicit param → session key parse (`agent:ghost:sessionkey`) → config default → `DEFAULT_AGENT_ID`
- None of these are a hard identity assertion from the call chain

**Assessment:** Acceptable risk given current implementation. The derivation is deterministic and not manipulable from outside the running process. A compromised actor with config write access could influence which agent context is used, but that actor already has equivalent access via other paths. The fail-closed check at line 721 is the correct guard: when `currentAgentId` is undefined/empty/whitespace on a shared workspace, dreaming is skipped entirely.

**Residual:** No runtime assertion if `ctx.agentId` is undefined. If the type allows undefined and the runtime also allows it, exploitation is silent. Adding a warning log when `ctx.agentId` is absent would close this gap without blocking the PR.

**Verdict:** No action required for PR. Document as follow-on hardening.

---

### (b) Race conditions in corpus file creation

**Finding:** No race conditions detected.

**Analysis:**

- Per-agent corpus files use `memory/.dreams/session-corpus/{agentId}/{day}.txt`
- Each agent writes to a different path (partitioned by `agentId`)
- `fs.mkdir` with `recursive: true` is used before write — atomic directory creation
- File writes use `fs.writeFile` (no append + read + write race since each agent has exclusive paths)

**Residual:** The `recordShortTermRecalls()` short-term store has a dedupe key of `{path, startLine, endLine, sessionKey}`. If a compromised agent in a shared workspace crafts a session entry with the same key as a legitimate entry from another agent, the store could overwrite or merge. Low risk: shared workspaces shouldn't exist in production, and per-agent corpus paths significantly reduce the collision surface.

**Verdict:** No action required. Document as known limitation.

---

### (c) Provenance replay across agents

**Finding:** Not exploitable.

**Analysis:**

- Provenance entries are written to `memory/.dreams/provenance.json` (shared file per workspace)
- The `appendProvenanceEntries()` function deduplicates by `id` (which is `candidate.key`, a stable identifier from the short-term store)
- Even if Agent A could write a provenance entry claiming Agent B's identity, the `contentHash` is computed from `candidate.snippet` which is read directly from the source file — not from any agent-controlled input
- The `agentId` field in the provenance entry comes from `options.currentAgentId` (the handler's `ctx.agentId`), not from the content being promoted

**Verdict:** Clean. No replay path exists.

---

### (d) Fail-closed regression under adversarial config

**Finding:** Whitespace-only bypass found and fixed.

**Original code:**

```typescript
if (match.shared && !currentAgentId) {
  return [];
}
```

**Problem:** JavaScript treats `"  "` (whitespace-only string) as truthy. A shared workspace with `currentAgentId = "  "` would return `["  "]` instead of `[]`.

**Impact:** Low in practice — `"  "` won't match any real agent's corpus path, so no data is processed. But the fail-closed guarantee is technically violated.

**Fix (commit aad87c3b):**

```typescript
if (match.shared && !currentAgentId?.trim()) {
  return [];
}
```

**Verification:** All 17 adversarial/isolation tests pass. Whitespace-only, empty string, and undefined all correctly trigger fail-closed.

**Verdict:** Gap found and fixed. Audit complete.

---

## Non-Blocking Findings (Noted for Follow-On)

### NB-1: ctx.agentId presence not guaranteed by type

The `PluginHookAgentContext.agentId` field is typed as `string | undefined`. Empirically it is always present for `heartbeat`, `cron`, and `on-demand` triggers (all go through `runEmbeddedPiAgent` which derives `agentId` from explicit param, session key, or config default). However, the type allows undefined. Adding a runtime assertion that logs a warning when `agentId` is absent would make the trust model explicit without changing behavior.

**Recommendation:** Add `if (!ctx.agentId?.trim()) { logger.warn('before_agent_reply called without agentId'); }` at the hook entry point. Follow-on, not a PR blocker.

---

### NB-2: Session key → agentId mapping is parseable

The session key format `agent:ghost:sessionkey` is used to derive `agentId`. A crafted session key could theoretically impersonate an agent identity. However:

- This only affects that specific run's context
- The fail-closed check limits damage: wrong agentId on a shared workspace skips dreaming entirely
- Only a actor with the ability to set session keys could exploit this

**Recommendation:** Consider validating that parsed agentId matches a known agent in the workspace config. Follow-on hardening.

---

### NB-3: REM narrative filter confirmed present

Gunn's concern about `remDreamingNarrative` / `buildRemDreamingNarrative` bypassing `filterRecallEntriesForAgentIsolation` was investigated. Both `runLightDreaming` (line 1634) and `runRemDreaming` (line 1747) call `filterRecallEntriesForAgentIsolation` on their read paths. No bypass exists.

---

## Layer-by-Layer Confirmation

| Layer                              | Status | Notes                                                                                                            |
| ---------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Layer 1: shared flag               | ✅     | Present in `MemoryDreamingWorkspace`, warnings at line 129 and 712                                               |
| Layer 2a: currentAgentId threading | ✅     | Threaded from `ctx.agentId` through full pipeline (7 functions)                                                  |
| Layer 2b: fail-closed              | ✅     | `currentAgentId?.trim()` at line 721 catches all edge cases                                                      |
| Layer 2c: per-agent corpus         | ✅     | Write: `session-corpus/{agentId}/{day}.txt`. Read: `filterRecallEntriesForAgentIsolation` at lines 1672 and 1785 |
| Layer 3: provenance sidecar        | ✅     | `memory/.dreams/provenance.json`, content hash from source, agentId from handler                                 |
| Tests                              | ✅     | 62/62 pass (17 isolation + 45 dreaming phases)                                                                   |

---

## Conclusion

The implementation is secure and ready for PR. The whitespace bypass gap was found and fixed during this audit. The three non-blocking findings are documented for follow-on hardening and do not affect the current PR's fitness for purpose.

**Ghost verdict:** APPROVED for upstream PR #76140.

---

_Audit complete. — Ghost_
