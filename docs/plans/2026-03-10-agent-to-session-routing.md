# Agent To Session Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `openclaw agent --agent <id> --to <target>` honor `--to` when resolving the session key instead of always collapsing to the agent's main session.

**Architecture:** Keep session resolution centralized in `src/commands/agent/session.ts`. Preserve current precedence for explicit `--session-key`, but when only `--agent` and `--to` are provided, derive the per-target key for that agent before falling back to the agent main-session alias.

**Tech Stack:** TypeScript, Vitest, PNPM

---

### Task 1: Add the failing regression tests

**Files:**
- Modify: `src/commands/agent/session.test.ts`

**Step 1: Write the failing test**

Add a regression test covering `--agent + --to`:

```ts
it("prefers a --to-derived session key over the agent main-session alias", () => {
  mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
  mocks.loadSessionStore.mockReturnValue({});

  const result = resolveSessionKeyForRequest({
    cfg: baseCfg,
    agentId: "mybot",
    to: "cw_111",
  });

  expect(result.sessionKey).toBe("agent:mybot:cw_111");
});
```

Add a protection test keeping explicit session keys highest priority:

```ts
it("keeps explicit sessionKey precedence over --agent and --to", () => {
  mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
  mocks.loadSessionStore.mockReturnValue({});

  const result = resolveSessionKeyForRequest({
    cfg: baseCfg,
    agentId: "mybot",
    to: "cw_111",
    sessionKey: "agent:mybot:main",
  });

  expect(result.sessionKey).toBe("agent:mybot:main");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/commands/agent/session.test.ts`

Expected: FAIL on the new `--agent + --to` regression because session resolution returns the agent main key.

**Step 3: Commit**

```bash
git add src/commands/agent/session.test.ts
git commit -m "test: cover agent to session routing"
```

### Task 2: Implement the minimal session-resolution fix

**Files:**
- Modify: `src/commands/agent/session.ts`

**Step 1: Write minimal implementation**

Update `resolveSessionKeyForRequest` so:

```ts
const explicitSessionKey = opts.sessionKey?.trim();
const normalizedAgentId = opts.agentId ? normalizeAgentId(opts.agentId) : undefined;
const explicitAgentMainSessionKey =
  !explicitSessionKey && !opts.to?.trim()
    ? resolveExplicitAgentSessionKey({
        cfg: opts.cfg,
        agentId: normalizedAgentId,
      })
    : undefined;

const storeAgentId = normalizedAgentId ?? resolveAgentIdFromSessionKey(explicitSessionKey);
```

Then derive `sessionKey` with:

```ts
const derivedToSessionKey =
  explicitSessionKey || !opts.to?.trim()
    ? undefined
    : normalizedAgentId
      ? toAgentStoreSessionKey({
          agentId: normalizedAgentId,
          requestKey: opts.to,
          mainKey,
        })
      : resolveSessionKey(scope, ctx, mainKey);

let sessionKey: string | undefined =
  explicitSessionKey ?? derivedToSessionKey ?? explicitAgentMainSessionKey;
```

Refactor as needed, but preserve:
- `--session-key` highest precedence
- existing `--session-id` reverse lookup behavior
- agent-scoped store selection when `--agent` is present

**Step 2: Run the targeted test suite**

Run: `pnpm exec vitest run src/commands/agent/session.test.ts`

Expected: PASS

**Step 3: Refactor for clarity if needed**

Keep helper names explicit and avoid changing unrelated routing semantics.

**Step 4: Commit**

```bash
git add src/commands/agent/session.ts src/commands/agent/session.test.ts
git commit -m "fix: honor --to when agent session is selected"
```

### Task 3: Verify no routing regressions in nearby code

**Files:**
- Inspect: `src/commands/agent.ts`
- Inspect: `src/commands/agent/session.test.ts`

**Step 1: Run focused verification**

Run: `pnpm exec vitest run src/commands/agent/session.test.ts src/commands/agent/session-store.test.ts`

Expected: PASS

**Step 2: Review diff**

Run: `git -C G:\\Rust\\openclaw diff -- src/commands/agent/session.ts src/commands/agent/session.test.ts docs/plans/2026-03-10-agent-to-session-routing.md`

Expected: Only the routing fix, tests, and plan document changed.

**Step 3: Prepare PR notes**

Include:
- Root cause: `--agent` selected the agent store, but session-key derivation still collapsed `--to` to the main-session alias
- Fix: let `--to` derive the agent-scoped session key unless `--session-key` was explicitly supplied
- Tests: targeted Vitest coverage for `--agent + --to` and explicit session-key precedence
