WORK LOG

Add your findings and worklogs by appending to the end of this file. Do not overwrite anything that is existing in this file. Write with the format being used.

[CODEX]

I've brought work into the workstream.

[CLAUDE]

I've assigned the work to eleqtrizit.

[CLAUDE REVIEW]

## Branch 354 — Security Fix: GHSA-7jp6-r74r-995q

**Date reviewed:** 2026-04-08  
**Commit reviewed:** `55326ffb07` (fix(matrix): gate profile updates for non-owner runs)  
**Issue source:** https://github.com/NVIDIA-dev/openclaw-tracking/issues/354

---

### What Is This Branch Trying to Accomplish?

This branch is a targeted security fix for a write-to-admin trust boundary break in the Matrix plugin.

**The vulnerability:** A gateway caller authenticated with `operator.write` scope (not admin) can invoke the WebSocket `agent` method — that's by design. Inside agent execution, non-owner callers (`senderIsOwner=false`) receive a restricted tool inventory. However, the shared `message` tool was still included in the non-owner inventory, and when the Matrix plugin is configured with `channels.matrix.actions.profile: true`, the `message` tool would expose a `set-profile` action. Executing that action reaches `applyMatrixProfileUpdate(...)` → `runtime.config.writeConfigFile(updated)`, which persists Matrix profile fields like `channels.matrix.name` and `channels.matrix.avatarUrl` to disk — an admin-class config mutation — despite the caller holding only write scope.

**The fix:** Two-layer defense in depth:

1. **Schema / discovery layer** — `set-profile` is now omitted from the Matrix action enum when `senderIsOwner === false`, so non-owner agents never see the action in their tool schema (reduced attack surface + no prompt-level exposure).
2. **Execution layer** — Even if the schema gate is somehow bypassed (e.g., by a caller directly invoking the tool with a crafted action name), `handleAction` for `set-profile` explicitly throws `"Matrix profile updates require owner access."` when `ctx.senderIsOwner === false`.

To thread the new context field through, `senderIsOwner?: boolean` is added to `ChannelMessageActionDiscoveryContext`, `ChannelMessageActionContext`, `ChannelMessageActionDiscoveryInput`, and the full call chain from `createOpenClawTools` → `createMessageTool` → `resolveMessageToolSchemaActions` / `buildMessageToolDescription` / `buildMessageToolSchema` → `listChannelSupportedActions` / `listAllChannelSupportedActions` → `createMessageActionDiscoveryContext` → plugin `describeMessageTool` callback → and then separately into `runMessageAction` → `handlePluginAction` → `dispatchChannelMessageAction` → plugin `handleAction` callback.

---

### Files Changed (10 files, +138 / -8)

| File                                                        | Role                                                                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/matrix/src/actions.ts`                          | Core fix — discovery filter + execution guard                                                                                                               |
| `src/channels/plugins/types.core.ts`                        | Extends `ChannelMessageActionDiscoveryContext` and `ChannelMessageActionContext` with `senderIsOwner?`                                                      |
| `src/channels/plugins/message-action-discovery.ts`          | Threads `senderIsOwner` through discovery input and context factory                                                                                         |
| `src/agents/channel-tools.ts`                               | Adds `senderIsOwner?` to `listChannelSupportedActions` and `listAllChannelSupportedActions`                                                                 |
| `src/agents/openclaw-tools.ts`                              | Passes `senderIsOwner` from tool options down to message tool creation                                                                                      |
| `src/agents/tools/message-tool.ts`                          | Threads `senderIsOwner` through all schema/description/execution paths; replaces `listChannelMessageActions` fallback with `listAllChannelSupportedActions` |
| `src/infra/outbound/message-action-runner.ts`               | Adds `senderIsOwner?` to `RunMessageActionParams` and forwards it to dispatch                                                                               |
| `extensions/matrix/src/actions.account-propagation.test.ts` | Test: non-owner execution rejection                                                                                                                         |
| `extensions/matrix/src/actions.test.ts`                     | Test: non-owner discovery filtering                                                                                                                         |
| `src/agents/tools/message-tool.test.ts`                     | Test: `senderIsOwner` forwarded through discovery + execution                                                                                               |

---

### Standards and Best Practices Assessment

**PASS — Correct ownership (plugin-owned fix)**  
The fix lives in `extensions/matrix/src/actions.ts`, not in core. This follows the CLAUDE.md rule: _"extension-owned compatibility behavior belongs to the owning extension."_ Core only gains a generic optional field on shared context types; it has no Matrix-specific branching.

**PASS — Defense in depth**  
Both layers are guarded: discovery filtering (schema-time) and execution rejection (runtime). The security advisory suggested doing one or the other; the fix correctly does both. The execution guard is essential because tool schema filtering alone can be circumvented by callers that hand-craft their tool invocation arguments.

**PASS — Generic seam, not a special case**  
`senderIsOwner` is threaded as a generic field on `ChannelMessageActionDiscoveryContext` and `ChannelMessageActionContext` — not as Matrix-specific logic in core. Any other plugin that has an admin-sink action can now check `ctx.senderIsOwner` using the same seam without a new core change.

**PASS — Backwards compatibility preserved**  
Every site uses `senderIsOwner?: boolean` (optional). The gate in Matrix uses `=== false` (discovery) / `=== false` (execution), meaning `undefined` is treated as "owner-level". Existing callers that don't set the field are unaffected.

**PASS — `listChannelMessageActions` fallback replaced correctly**  
The old fallback path in `message-tool.ts` called `listChannelMessageActions()` which had no awareness of `senderIsOwner`. This is now replaced with `listAllChannelSupportedActions({...senderIsOwner})`, closing the bypass through the no-current-channel code path.

**PASS — Test coverage at three distinct layers**  
Tests verify: (1) Matrix plugin discovery omits `set-profile` for non-owner, (2) Matrix plugin execution throws for non-owner, (3) message-tool correctly passes `senderIsOwner` through into discovery and execution. This matches the CLAUDE.md guidance on scoped tests proving the change itself.

**PASS — No TS suppressions, no `any` introductions, no lint bypasses**  
The change is well-typed throughout.

---

### Concerns and Observations

**Minor concern — `undefined` default means "owner"**  
The check `senderIsOwner !== false` treats `undefined` as "owner-level access" for backwards compatibility. This is correct for existing callers, but it is a latent footgun: any new call site that forgets to set `senderIsOwner: false` for a non-owner context will silently get elevated access. There is no lint/type check to enforce that new agent execution paths set this field explicitly. A future improvement would be to make the field required in the execution context or add a default-to-non-owner policy in the ingress layer rather than default-to-owner.

**Minor concern — Scope is Matrix-only**  
Only the Matrix `set-profile` action is hardened. The issue description explicitly calls out `applyMatrixProfileUpdate → writeConfigFile` as the known sink. Other plugins with potential config-persistence actions (if any exist) are not audited in this change. This is acceptable as a scoped fix, but a follow-up audit of other plugins' `handleAction` implementations for similar config-write sinks would be prudent.

**Observation — `listChannelMessageCapabilitiesForChannel` gets `senderIsOwner` in params but is not tested**  
The field is added to the function's params interface in `message-action-discovery.ts`, but it's passed through `createMessageActionDiscoveryContext` (which does thread it). The change is consistent — no gap — but there's no test that exercises the capability discovery path with `senderIsOwner: false`. Low risk since capability discovery is a read path, not a write path.

**Observation — Minor dead import cleanup bundled in**  
`extensions/matrix/src/actions.ts` removes the unused `ChannelToolSend` import and drops the explicit return type annotation on `extractToolSend`. These are clean and correct but are packaging-level details alongside a security fix; they're harmless.

---

### Verdict

The fix is correct, well-scoped, follows repo architecture rules, and applies defense in depth. The `senderIsOwner` context field is the right generic seam to add. Test coverage is appropriate. The main long-term risk is the "undefined = owner" default semantic, which is a documentation and developer-experience concern rather than a current security issue.

---

[CLAUDE PLAN]

## Fix Plan for PR #62662 Review Comments

**Date:** 2026-04-08  
**PR:** https://github.com/openclaw/openclaw/pull/62662  
**Issue source:** https://github.com/NVIDIA-dev/openclaw-tracking/issues/354

---

### Issue 1 — P1: Execution guard uses permissive `=== false` instead of strict `!== true`

**Root cause:**

In `extensions/matrix/src/actions.ts`, both the discovery and execution gates use "deny if explicitly false" semantics:

- Discovery (line 54): `params.senderIsOwner !== false` — includes `set-profile` when `senderIsOwner` is `undefined`
- Execution (line 262): `ctx.senderIsOwner === false` — allows `set-profile` when `senderIsOwner` is `undefined`

The `pi-tools.ts` file (line 636) already establishes the correct repo pattern for owner checks:

```typescript
// Security: treat unknown/undefined as unauthorized (opt-in, not opt-out)
const senderIsOwner = options?.senderIsOwner === true;
```

The Matrix action gates are inconsistent with that pattern. Any call path that creates a `ChannelMessageActionContext` without explicitly setting `senderIsOwner` (e.g., a future agent invocation route not yet threaded through the gateway) would bypass both guards.

**Is this currently exploitable?** Not through the gateway — `resolveSenderIsOwnerFromClient` in `src/gateway/server-methods/agent.ts` always returns a boolean (`scopes.includes(ADMIN_SCOPE)`), never `undefined`. But the gate fails open for any non-gateway call path that omits the field, which is a latent risk for new code paths.

**Fix: `extensions/matrix/src/actions.ts`**

1. In `createMatrixExposedActions` (line 54): change

   ```typescript
   if (params.gate("profile") && params.senderIsOwner !== false) {
   ```

   to:

   ```typescript
   if (params.gate("profile") && params.senderIsOwner === true) {
   ```

2. In `handleAction` for `set-profile` (line 262): change
   ```typescript
   if (ctx.senderIsOwner === false) {
     throw new Error("Matrix profile updates require owner access.");
   }
   ```
   to:
   ```typescript
   if (ctx.senderIsOwner !== true) {
     throw new Error("Matrix profile updates require owner access.");
   }
   ```

**Compatibility check required:** All legitimate `set-profile` callers must explicitly set `senderIsOwner: true`. Gateway admin paths already do (via `resolveSenderIsOwnerFromClient`). Any non-gateway CLI/direct agent paths that legitimately invoke `set-profile` must be identified and updated to set `senderIsOwner: true`. Audit `src/agents/pi-tools.ts` and any CLI commands that create tools without going through the gateway `agent` method.

**Test updates: `extensions/matrix/src/actions.test.ts` and `extensions/matrix/src/actions.account-propagation.test.ts`**

- Add test case: `senderIsOwner: undefined` should also hide `set-profile` from the discovered actions list (discovery guard)
- Add test case: `senderIsOwner: undefined` should also throw `"Matrix profile updates require owner access."` at execution (execution guard)

---

### Issue 2 — P2: `broadcast` missing from unscoped message tool schemas

**Root cause:**

Before this branch, the unscoped fallback path in `resolveMessageToolSchemaActions` (`src/agents/tools/message-tool.ts`) called `listChannelMessageActions(cfg)` from `message-action-discovery.ts`. That function seeds the action set with `["send", "broadcast"]` before adding plugin-declared actions, so `broadcast` was always present.

This branch replaced that call with `listAllChannelSupportedActions(...)` (from `src/agents/channel-tools.ts`) to thread `senderIsOwner` through. But `listAllChannelSupportedActions` only aggregates plugin-declared actions — it does not seed with core actions. `broadcast` is a core action not declared by any plugin, so it disappears from the unscoped tool schema.

**Effect:** Any unscoped/isolated run (no `currentChannelProvider` set — e.g., cron agents, isolated agents) that calls `message` with `action: "broadcast"` receives a tool-argument validation failure because `broadcast` is no longer in the action enum.

**Fix: `src/agents/tools/message-tool.ts`**

In `resolveMessageToolSchemaActions`, the unscoped path (currently lines 466-478):

```typescript
const actions = listAllChannelSupportedActions({
  cfg: params.cfg,
  ...
  senderIsOwner: params.senderIsOwner,
});
return actions.length > 0 ? actions : ["send"];
```

Change to seed with core actions, matching the old `listChannelMessageActions` behavior:

```typescript
const pluginActions = listAllChannelSupportedActions({
  cfg: params.cfg,
  ...
  senderIsOwner: params.senderIsOwner,
});
// Preserve core actions (send, broadcast) that are not plugin-owned
const actions = new Set<string>(["send", "broadcast", ...pluginActions]);
return Array.from(actions);
```

**Test: `src/agents/tools/message-tool.test.ts`**

Add a regression test that verifies `broadcast` (and `send`) appear in the action enum when `resolveMessageToolSchemaActions` / `buildMessageToolSchema` is called with no `currentChannelProvider` set, regardless of which plugins are registered.

---

### Larger hidden problem check

No broader hidden problem was found. Specifically:

- **Other channels with config-write sinks:** The issue report identifies `applyMatrixProfileUpdate → writeConfigFile` as the specific admin sink. No other plugin is known to have a similar pattern in their `handleAction`, and the PR scope is correctly limited to Matrix.
- **Other permissive owner gates:** The `=== false` pattern is only used in this PR's new code (Matrix `set-profile`). The rest of the repo uses `=== true` checks for owner-gating (e.g., `pi-tools.ts`). This is an isolated inconsistency in the new code, not a systemic problem.
- **`listAllChannelSupportedActions` correctness elsewhere:** The function is also used in `buildMessageToolDescription` (unscoped fallback, line 650). That path would similarly miss `broadcast` in the description string, but it's cosmetic (description vs. schema). The schema fix in `resolveMessageToolSchemaActions` is the critical one.

---

### Verification steps

1. `pnpm test extensions/matrix/src/actions.test.ts extensions/matrix/src/actions.account-propagation.test.ts src/agents/tools/message-tool.test.ts`
2. `pnpm check`
3. Confirm the PoC test (`src/gateway/server.agent-matrix-set-profile-write-scope.poc.test.ts`) still passes and now also asserts `set-profile` is absent (not just that the runner blocks it).

[CODEX SUMMARY]

Implemented Claude's follow-up fixes for issue 354 on this branch.

- Tightened the Matrix `set-profile` owner gate in `extensions/matrix/src/actions.ts` to fail closed: discovery now exposes `set-profile` only when `senderIsOwner === true`, and execution now rejects unless `ctx.senderIsOwner === true`.
- Added regression coverage in `extensions/matrix/src/actions.test.ts` and `extensions/matrix/src/actions.account-propagation.test.ts` so `senderIsOwner: undefined` is treated as unauthorized for both discovery and execution.
- Restored the shared `message` tool's unscoped core actions in `src/agents/tools/message-tool.ts` by reseeding fallback actions with `send` and `broadcast`, then reused that same helper for the generic fallback description so schema and description stay aligned.
- Added shared-tool regressions in `src/agents/tools/message-tool.test.ts` covering the unscoped `broadcast` action enum and fallback description.
- The PoC file referenced in the plan (`src/gateway/server.agent-matrix-set-profile-write-scope.poc.test.ts`) is not present on this branch, so I could not update or rerun that exact test here.

[CODEX REVIEW FOLLOW-UP]

Reviewed `NVIDIA-dev/openclaw-tracking#354` and `openclaw/openclaw#62662` comments.

- Tracking issue comment state is minimal: only the PR link comment from `eleqtrizit`, no follow-up action requested there.
- PR `#62662` had two unresolved Codex review threads:
  - fail-closed owner gating for Matrix `set-profile`
  - restore `broadcast` in unscoped message-tool schemas
- Verified both are addressed in the current working tree:
  - `extensions/matrix/src/actions.ts` now requires `senderIsOwner === true` for discovery and `ctx.senderIsOwner !== true` rejects execution
  - `src/agents/tools/message-tool.ts` now reseeds the unscoped fallback with `send` and `broadcast`
  - regression coverage added in `extensions/matrix/src/actions.test.ts`, `extensions/matrix/src/actions.account-propagation.test.ts`, and `src/agents/tools/message-tool.test.ts`
- Validation run completed successfully:
  - `corepack pnpm test extensions/matrix/src/actions.test.ts extensions/matrix/src/actions.account-propagation.test.ts src/agents/tools/message-tool.test.ts`
  - result: passed (`3` files / `50` tests total across the run output)
- Resolved both addressed Codex PR threads and posted fresh review trigger comments:
  - `@codex review`
  - `@greptile review`

[CODEX COMMENTS RESOLUTION]

Worked `NVIDIA-dev/openclaw-tracking#354` against `openclaw/openclaw#62662` using the current Codex follow-up review state.

- Pulled context from `gh issue view 354 -R NVIDIA-dev/openclaw-tracking --json number,title,body,state,labels,url` and re-read `USER.md` before touching the branch.
- Queried PR review threads directly and confirmed one remaining unresolved Codex thread on `src/agents/tools/message-tool.ts` covering the fallback `broadcast` regression.
- Verified the local branch already addressed both Codex findings:
  - `extensions/matrix/src/actions.ts` now requires explicit owner context for Matrix `set-profile` discovery and execution.
  - `src/agents/tools/message-tool.ts` now restores core fallback actions through a shared helper that keeps `send` and `broadcast` available in unscoped schemas and descriptions.
- Confirmed the added regression coverage in:
  - `extensions/matrix/src/actions.test.ts`
  - `extensions/matrix/src/actions.account-propagation.test.ts`
  - `src/agents/tools/message-tool.test.ts`
- Validation run passed:
  - `corepack pnpm test extensions/matrix/src/actions.test.ts extensions/matrix/src/actions.account-propagation.test.ts src/agents/tools/message-tool.test.ts`
  - result: passed (`2` Vitest project runs, `50` tests total)
- Next PR workflow actions after this log append:
  - commit and push the validated fixes
  - resolve the addressed remaining Codex thread
  - refresh bot review triggers cleanly if no approval is already present

[CLAUDE COMMENTS RESOLUTION]

## PR 62662 — fix(matrix): thread senderIsOwner into HTTP tool-invoke path

**Date:** 2026-04-08
**Issue:** https://github.com/NVIDIA-dev/openclaw-tracking/issues/354
**PR:** https://github.com/openclaw/openclaw/pull/62662

### Thread Status at Start

- PRRT_kwDOQb6kR855XbMr — Resolved (outdated): P2 broadcast in unscoped fallback — already addressed by prior commits
- PRRT_kwDOQb6kR855XbMz — Resolved (outdated): P1 fail-closed owner gate — already addressed by prior commits
- PRRT_kwDOQb6kR855cda0 — Resolved (outdated): P1 broadcast in fallback schema — already addressed by prior commits
- PRRT_kwDOQb6kR855o-pV — **Unresolved**: P2 Propagate owner context for Matrix set-profile (HTTP tool-invoke path)

### Fix Applied

The one remaining unresolved Codex thread identified that `senderIsOwner` was computed AFTER `resolveGatewayScopedTools` in `tools-invoke-http.ts`, meaning the message tool was created without it. This caused `ctx.senderIsOwner === undefined` at execution time, which the fail-closed Matrix guard (`!== true`) correctly rejected — including for authenticated owners.

**Changes:**

- `src/gateway/tool-resolution.ts`: added `senderIsOwner?` param and threaded it into `createOpenClawTools`
- `src/gateway/tools-invoke-http.ts`: moved `senderIsOwner` computation before `resolveGatewayScopedTools` call; passed it in

**Commit:** `30c0e94042` — `fix(matrix): thread senderIsOwner into HTTP tool-invoke path`

### Actions Taken

- Ran tests: all 4 test files passed (actions.test.ts, actions.account-propagation.test.ts, message-tool.test.ts, mcp-http.test.ts)
- Ran `pnpm check` via scripts/committer: passed
- Pushed branch to origin/354
- Resolved thread PRRT_kwDOQb6kR855o-pV via GitHub GraphQL API
- Deleted previous `@greptile review` / `@codex review` trigger comments (IDs 4208302842, 4208302853)
- Posted fresh `@greptile review` and `@codex review` triggers

[CODEX COMMENTS RESOLUTION]

Worked `NVIDIA-dev/openclaw-tracking#354` against the current live thread state on `openclaw/openclaw#62662`.

- Re-read `USER.md` and refreshed issue context with:
  - `gh issue view 354 -R NVIDIA-dev/openclaw-tracking --json number,title,body,state,labels,url`
- Queried live PR review threads and found two unresolved threads on the current PR state:
  - Codex: HTTP `/tools/invoke` owner-context propagation for Matrix `set-profile`
  - Greptile: remove `USER.md` from the PR because it contains private tracking / unreleased GHSA references
- Confirmed the local branch already contains the HTTP owner-context code fix in commit `30c0e94042` (`fix(matrix): thread senderIsOwner into HTTP tool-invoke path`):
  - `src/gateway/tool-resolution.ts` now accepts and forwards `senderIsOwner`
  - `src/gateway/tools-invoke-http.ts` now computes `senderIsOwner` before `resolveGatewayScopedTools(...)` and passes it into tool creation
- Added regression coverage in `src/gateway/tools-invoke-http.test.ts` to prove `/tools/invoke` threads `senderIsOwner` into tool creation for both write-scoped and admin-scoped callers before owner-only filtering runs.
- Removed `USER.md` from Git tracking for the PR while keeping the local file/worklog in place, so the branch no longer publishes the tracking issue / GHSA details through that artifact.
- Validation planned/performed for this resolution:
  - `corepack pnpm test src/gateway/tools-invoke-http.test.ts`
- PR cleanup planned/performed after validation:
  - resolve the addressed Codex HTTP owner-context thread
  - resolve the addressed Greptile `USER.md` thread
  - delete stale `@greptile review` / `@codex review` trigger comments if present
  - post fresh review triggers only as exact trigger comments
