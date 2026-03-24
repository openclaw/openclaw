# Fix Subagent Session `agentId` Attribution

## Problem

Spawned specialist sessions are created with the correct child session key (`agent:mew:subagent:…`, `agent:charmander:subagent:…`, etc.), but downstream activity/session payloads can still surface them as `agentId: "main"`.

Observed downstream evidence:

- titles such as `mew-real-attribution-check`, `charmander-real-attribution-check`, `bulbasaur-real-attribution-check`
- payloads still tagged with `agentId: "main"`

This is not a spawn-key construction bug. The child key is correct at creation time. The attribution bug appears later, when transcript placement and usage/activity discovery re-derive agent identity.

---

## Traced Code Path

### 1) Spawn creates the correct child session identity

**File:** `src/agents/subagent-spawn.ts`
**Function:** `spawnSubagentDirect()`

The child session key is already correct:

```ts
const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
```

`spawnSubagentDirect()` then:

1. patches the provisional child session via `sessions.patch`
2. starts the run via gateway `agent`
3. passes `sessionKey: childSessionKey`

So the spawned session identity is born correctly.

### 2) Gateway preserves the child session key during run startup

**File:** `src/gateway/server-methods/agent.ts`
**Function:** `agentHandlers.agent`

When `request.sessionKey` is provided, the handler loads that exact session entry, resolves:

```ts
const sessionAgent = resolveAgentIdFromSessionKey(canonicalKey);
```

and registers the run context with the canonical child key:

```ts
registerAgentRunContext(idem, { sessionKey: canonicalSessionKey });
```

So the gateway-side run context is also correct.

### 3) The first real identity loss happens when transcript paths are chosen

**Files:**

- `src/config/sessions/paths.ts`
- transitively from `src/agents/agent-command.ts` / transcript persistence helpers

**Exact functions:**

- `resolveSessionFilePathOptions()`
- `resolveSessionFilePath()`

#### Current behavior

When a session has no persisted `sessionFile` yet, transcript persistence eventually falls back to:

```ts
return resolveSessionTranscriptPathInDir(sessionId, sessionsDir);
```

inside `resolveSessionFilePath()`.

But `sessionsDir` comes from `resolveSessionFilePathOptions()`:

```ts
if (storePath && storePath !== MULTI_STORE_PATH_SENTINEL) {
  const sessionsDir = path.dirname(path.resolve(storePath));
  return agentId ? { sessionsDir, agentId } : { sessionsDir };
}
```

That means **store location wins over `agentId`** for brand-new transcripts.

#### Why this matters

For shared/default-store layouts, a child session for `agent:mew:subagent:...` can be written into the same transcript directory used by the parent/default agent. The session key remains `agent:mew:...`, but the physical transcript placement is now parent/default scoped.

This is the first place the spawned child can start looking like `main` downstream.

### 4) Activity/session discovery then reuses the scan agent instead of the child agent

**File:** `src/gateway/server-methods/usage.ts`
**Function:** `discoverAllSessionsForUsage()`

Current code:

```ts
const results = await Promise.all(
  agents.map(async (agent) => {
    const sessions = await discoverAllSessions({
      agentId: agent.id,
      startMs: params.startMs,
      endMs: params.endMs,
    });
    return sessions.map((session) => ({ ...session, agentId: agent.id }));
  }),
);
```

This is the concrete place where the wrong `agentId` is emitted:

- transcripts are discovered by scanning an agent directory
- every discovered session is stamped with the **directory/loop agent** (`agent.id`)
- there is no verification against the canonical session key/session store identity

So if a spawned specialist transcript is sitting in the parent/default transcript directory, `discoverAllSessionsForUsage()` emits it as `agentId: "main"`.

That matches the observed failure pattern exactly:

- title/label can still reflect the child run (`mew-real-attribution-check`)
- emitted activity payload still says `agentId: "main"`

---

## Root Cause

This is a **two-part attribution bug**:

1. **Transcript placement bug**: new session transcripts are resolved from `storePath`/directory first, not the session's canonical agent identity.
2. **Discovery attribution bug**: `discoverAllSessionsForUsage()` assigns `agentId` from the scan loop (`agent.id`) instead of the canonical session identity.

The combination causes spawned child sessions to be observable downstream as `main`, even though the spawned session key itself is correct.

---

## Required Fix

### Fix 1 — Make transcript placement follow the session agent, not the parent/default store dir

**Primary change:** `src/config/sessions/paths.ts`

#### Exact change

Update transcript fallback so a known `agentId` wins for new transcript creation.

Today:

```ts
export function resolveSessionFilePath(
  sessionId: string,
  entry?: { sessionFile?: string },
  opts?: SessionFilePathOptions,
): string {
  const sessionsDir = resolveSessionsDir(opts);
  const candidate = entry?.sessionFile?.trim();
  if (candidate) {
    try {
      return resolvePathWithinSessionsDir(sessionsDir, candidate, { agentId: opts?.agentId });
    } catch {
      // Keep handlers alive when persisted metadata is stale/corrupt.
    }
  }
  return resolveSessionTranscriptPathInDir(sessionId, sessionsDir);
}
```

Required behavior:

- if `entry.sessionFile` already exists, preserve current compatibility behavior
- if no `entry.sessionFile` exists **and** `opts.agentId` is known, create the transcript under the canonical agent transcript root for that agent
- only fall back to `sessionsDir` when no `agentId` is available

Implementation shape:

```ts
if (candidate) {
  ...existing behavior...
}
if (opts?.agentId) {
  return resolveSessionTranscriptPath(sessionId, opts.agentId);
}
return resolveSessionTranscriptPathInDir(sessionId, sessionsDir);
```

This is the surgical fix that stops brand-new child transcripts from being born in the parent/default directory.

### Fix 2 — Stop emitting discovered session `agentId` from the scan loop

**Primary change:** `src/gateway/server-methods/usage.ts`

#### Exact change

`discoverAllSessionsForUsage()` must not permanently stamp discovered sessions with `agent.id` from the outer loop.

Current buggy line:

```ts
return sessions.map((session) => ({ ...session, agentId: agent.id }));
```

Required behavior:

- prefer canonical agent identity from the combined session store by `sessionId`
- if no store match exists, fall back to a transcript-derived or path-derived agent id when possible
- only use the scan-loop agent as a last resort

Implementation-ready approach:

1. Load the combined session store once at the start of `discoverAllSessionsForUsage()`.
2. Build a `Map<sessionId, sessionKey>` from store entries.
3. For each discovered transcript:
   - `const canonicalKey = storeBySessionId.get(session.sessionId)`
   - `const canonicalAgentId = parseAgentSessionKey(canonicalKey)?.agentId`
   - emit `{ ...session, agentId: canonicalAgentId ?? agent.id }`

Pseudo-diff:

```ts
const { store } = loadCombinedSessionStoreForGateway(params.config);
const storeBySessionId = buildStoreBySessionId(store);
...
return sessions.map((session) => {
  const storeMatch = storeBySessionId.get(session.sessionId);
  const canonicalAgentId = parseAgentSessionKey(storeMatch?.key)?.agentId;
  return {
    ...session,
    agentId: canonicalAgentId ?? agent.id,
  };
});
```

This makes activity/session emission resilient even for historical transcripts already written in the wrong directory.

### Fix 3 — Add a regression test for cross-agent spawned sessions under shared/default store layouts

The issue only shows up when physical transcript placement and discovery diverge from canonical session key identity. Tests must cover that explicitly.

---

## Compatibility / Migration

### Backward compatibility

This should be backward-compatible.

- Existing sessions with persisted `sessionFile` continue to resolve from their stored path.
- Existing session keys do not change.
- Existing store entries do not need rewriting.

### Migration concerns

No schema migration is required.

However:

- **new sessions** after the fix may write transcripts into agent-specific transcript roots where older sessions for the same deployment were written into a shared/default directory
- historical sessions already written to the wrong directory may still exist there

That is why **Fix 2** is required along with **Fix 1**: it makes activity discovery recover canonical `agentId` from the session store for existing sessions, not just future ones.

### Optional cleanup

A follow-up maintenance command could later move old transcripts into canonical agent roots, but that is not required for correctness if discovery is fixed.

---

## Validation

### Unit tests

#### 1) Transcript fallback honors child agent identity

**File:** `src/config/sessions/paths.test.ts` (or nearest existing test file)

Add a test proving that when:

- `opts.agentId = "mew"`
- `opts.sessionsDir` points at the default/main/shared sessions dir
- `entry.sessionFile` is absent

then `resolveSessionFilePath()` returns the `mew` transcript root, not the parent/default one.

Expected assertion shape:

```ts
expect(
  resolveSessionFilePath(sessionId, undefined, { agentId: "mew", sessionsDir: mainDir }),
).toContain("/agents/mew/sessions/");
```

#### 2) Usage discovery prefers canonical store key agent over scan-loop agent

**File:** `src/gateway/server-methods/usage.sessions-usage.test.ts`

Add a case where:

- a transcript file is discovered while scanning the `main` directory
- the combined session store contains the same `sessionId` under key `agent:mew:subagent:child`

Expected result:

- emitted session/activity entry uses `agentId: "mew"`
- not `main`

### Integration / gateway validation

Create or extend a gateway test that simulates:

1. parent session `agent:main:main`
2. `sessions_spawn` with `agentId: "mew"` and label `mew-real-attribution-check`
3. child session creation with canonical key `agent:mew:subagent:...`
4. transcript creation for that child
5. `sessions.usage` or the relevant activity-producing method

Expected outcome:

- returned/emitted session key remains `agent:mew:subagent:...` (or canonical store-matched key)
- returned/emitted `agentId === "mew"`
- never `main`

### Manual validation

Reproduce with three spawned agents:

- `mew-real-attribution-check`
- `charmander-real-attribution-check`
- `bulbasaur-real-attribution-check`

Then verify downstream payloads now show:

- `title: "mew-real-attribution-check", agentId: "mew"`
- `title: "charmander-real-attribution-check", agentId: "charmander"`
- `title: "bulbasaur-real-attribution-check", agentId: "bulbasaur"`

and no longer:

- `agentId: "main"`

---

## Summary of Exact Files / Functions to Change

### Required

1. **`src/config/sessions/paths.ts`**
   - `resolveSessionFilePath()`
   - make new transcript fallback prefer `opts.agentId`

2. **`src/gateway/server-methods/usage.ts`**
   - `discoverAllSessionsForUsage()`
   - derive emitted `agentId` from canonical store/session identity, not the outer scan-loop agent

### Tests

3. **`src/gateway/server-methods/usage.sessions-usage.test.ts`**
   - add regression for discovered-in-main / canonical-key-in-child-agent case

4. **`src/config/sessions/paths.*.test.ts`**
   - add regression for transcript fallback path selection

---

## Why this is the right upstream fix

The spawn/session-key path is already correct. The real bug is that later layers re-materialize identity from the wrong source:

- transcript directory instead of canonical child agent
- scan-loop/default agent instead of session key/store identity

Fixing those two points restores end-to-end attribution without changing spawn semantics or session-key format.
