# Security Review — agentId propagation fix

**Reviewer:** Arcanine 🐕  
**Verdict:** PASS

## Scope reviewed

Commit reviewed: `2e520502bf4c6ae61ab93b725ab0898f3500815a` (`fix: persist subagent agentId in session entries`)

Files:

- `src/agents/subagent-spawn.ts`
- `src/config/sessions/types.ts`
- `src/gateway/server-methods/agent.ts`

## Findings

### 1) No new spoofing path introduced

The new `agentId` value is not accepted from untrusted client input in the normal patch flow:

- `sessions.patch` is schema-validated with `additionalProperties: false`
- `SessionsPatchParamsSchema` does **not** allow `agentId`
- `applySessionsPatchToStore()` does not expose a caller-controlled `agentId` field

So this change does **not** create a new RPC surface where a user can patch an arbitrary session entry to impersonate another agent.

### 2) Stored `agentId` is derived from the canonical session key

In both touched write paths, the persisted value comes from already-derived internal state:

- `subagent-spawn.ts` writes `agentId: targetAgentId`
- `server-methods/agent.ts` writes `agentId: sessionAgent`, where `sessionAgent` is derived from the canonical session key via `resolveAgentIdFromSessionKey(...)`

That means the persisted field is effectively a denormalized copy of the existing authority source, not a new authority source.

### 3) Isolation model is unchanged

I checked surrounding session resolution/listing/model-resolution code paths. Security-sensitive routing still derives the agent from the session key/config, not from `SessionEntry.agentId`.

This matters because even if a stale or hand-edited store entry had a mismatched `agentId`, the key-derived agent identity remains the thing that drives session scoping in the reviewed paths.

## Residual risk / watch item

Not a blocker for this fix, but worth preserving as an invariant:

- `SessionEntry.agentId` should remain **informational/denormalized only**.
- Future code should avoid trusting `entry.agentId` over the canonical session key when making authorization, workspace, tool-policy, or delivery-isolation decisions.

If a later refactor starts preferring persisted `entry.agentId` over key-derived identity, that could create a spoofing/confusion bug for manually edited or migrated stores.

## Bottom line

This fix looks safe.

Persisting `agentId` here improves downstream consumers that do not parse session keys, but it does not materially weaken agent isolation because:

1. callers cannot set it through the public `sessions.patch` API,
2. the stored value is derived from internal canonical agent identity,
3. reviewed routing logic still treats the session key/config as authoritative.
