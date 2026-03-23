# `message_received` Opt-In Blocking Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `mode: "blocking"` option to the `message_received` plugin hook so security/policy plugins can perform async inbound checks before agent dispatch, while preserving existing fire-and-forget behavior for all current plugins.

**Architecture:** Partition `message_received` handlers at runtime into observer (default, fire-and-forget) and blocking (opt-in, sequential + awaited) buckets. Blocking handlers return a `PluginHookMessageReceivedResult` with `cancel`, `blockReason`, and `replyText`. The inbound dispatch path awaits blocking handlers before `markProcessing()` and short-circuits on `cancel: true`.

**Tech Stack:** TypeScript (ESM), Vitest

**Spec:** `docs/plugins/message-received-blocking-opt-in-handoff.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/plugins/types.ts` | New result type, mode union, typed hook options, updated handler signature, registration metadata |
| Modify | `src/plugins/registry.ts` | Accept and persist `messageReceivedMode` on registration |
| Modify | `src/plugins/hooks.ts` | New `runVoidHooksList` / `runModifyingHooksList` helpers; rewrite `runMessageReceived` to partition and run both buckets |
| Modify | `src/plugins/hooks.test-helpers.ts` | Extend `addTestHook` and `createMockPluginRegistry` to support `messageReceivedMode` |
| Modify | `src/plugins/wired-hooks-message.test.ts` | Runner-level tests for observer/blocking behavior |
| Modify | `src/auto-reply/reply/dispatch-from-config.ts` | Await blocking result, early-return on cancel |
| Modify | `src/auto-reply/reply/dispatch-from-config.test.ts` | Dispatch-level tests for cancel-without-reply and cancel-with-reply |

---

## Task 1: Add types to `src/plugins/types.ts`

**Files:**
- Modify: `src/plugins/types.ts:1685-1686` (after message_received event type)
- Modify: `src/plugins/types.ts:1378-1382` (api.on signature)
- Modify: `src/plugins/types.ts:1939-1942` (handler map entry)
- Modify: `src/plugins/types.ts:2004-2010` (PluginHookRegistration)

- [ ] **Step 1: Add `PluginHookMessageReceivedResult` and mode types**

After line 1685 (the closing `};` of `PluginHookMessageReceivedEvent`), add:

```ts
export type PluginHookMessageReceivedResult = {
  cancel?: boolean;
  blockReason?: string;
  replyText?: string;
};

export type PluginHookMessageReceivedMode = "observe" | "blocking";
```

- [ ] **Step 2: Add typed hook options type**

Below the new mode type, add:

```ts
export type OpenClawPluginTypedHookOptions<K extends PluginHookName> = {
  priority?: number;
} & (K extends "message_received"
  ? { mode?: PluginHookMessageReceivedMode }
  : Record<never, never>);
```

- [ ] **Step 3: Update `OpenClawPluginApi["on"]` signature**

Change lines 1378-1382 from:

```ts
on: <K extends PluginHookName>(
  hookName: K,
  handler: PluginHookHandlerMap[K],
  opts?: { priority?: number },
) => void;
```

to:

```ts
on: <K extends PluginHookName>(
  hookName: K,
  handler: PluginHookHandlerMap[K],
  opts?: OpenClawPluginTypedHookOptions<K>,
) => void;
```

- [ ] **Step 4: Update `PluginHookHandlerMap["message_received"]` return type**

Change lines 1939-1942 from:

```ts
message_received: (
  event: PluginHookMessageReceivedEvent,
  ctx: PluginHookMessageContext,
) => Promise<void> | void;
```

to:

```ts
message_received: (
  event: PluginHookMessageReceivedEvent,
  ctx: PluginHookMessageContext,
) => Promise<PluginHookMessageReceivedResult | void> | PluginHookMessageReceivedResult | void;
```

- [ ] **Step 5: Add `messageReceivedMode` to `PluginHookRegistration`**

Change lines 2004-2010 from:

```ts
export type PluginHookRegistration<K extends PluginHookName = PluginHookName> = {
  pluginId: string;
  hookName: K;
  handler: PluginHookHandlerMap[K];
  priority?: number;
  source: string;
};
```

to:

```ts
export type PluginHookRegistration<K extends PluginHookName = PluginHookName> = {
  pluginId: string;
  hookName: K;
  handler: PluginHookHandlerMap[K];
  priority?: number;
  source: string;
  messageReceivedMode?: PluginHookMessageReceivedMode;
};
```

- [ ] **Step 6: Verify types compile**

Run: `pnpm tsgo`

Expected: no new errors in `src/plugins/types.ts`. Existing errors elsewhere are fine.

- [ ] **Step 7: Commit**

```
scripts/committer "feat(plugins): add message_received blocking result and mode types" src/plugins/types.ts
```

---

## Task 2: Persist mode in `src/plugins/registry.ts`

**Files:**
- Modify: `src/plugins/registry.ts:776-823` (`registerTypedHook`)

- [ ] **Step 1: Update `registerTypedHook` opts parameter**

Change line 780 from:

```ts
opts?: { priority?: number },
```

to:

```ts
opts?: OpenClawPluginTypedHookOptions<K>,
```

Add the import at the top of the file (alongside existing type imports from `./types.js`):

```ts
OpenClawPluginTypedHookOptions,
```

- [ ] **Step 2: Persist `messageReceivedMode` on the stored registration**

Change lines 816-822 from:

```ts
registry.typedHooks.push({
  pluginId: record.id,
  hookName,
  handler: effectiveHandler,
  priority: opts?.priority,
  source: record.source,
} as TypedPluginHookRegistration);
```

to:

```ts
registry.typedHooks.push({
  pluginId: record.id,
  hookName,
  handler: effectiveHandler,
  priority: opts?.priority,
  source: record.source,
  messageReceivedMode:
    hookName === "message_received" && opts && "mode" in opts
      ? (opts.mode ?? undefined)
      : undefined,
} as TypedPluginHookRegistration);
```

- [ ] **Step 3: Verify types compile**

Run: `pnpm tsgo`

Expected: no new errors.

- [ ] **Step 4: Commit**

```
scripts/committer "feat(plugins): persist messageReceivedMode on hook registration" src/plugins/registry.ts
```

---

## Task 3: Extract list helpers and rewrite `runMessageReceived` in `src/plugins/hooks.ts`

**Files:**
- Modify: `src/plugins/hooks.ts:242-263` (runVoidHook), `src/plugins/hooks.ts:269-303` (runModifyingHook), `src/plugins/hooks.ts:587-592` (runMessageReceived)

- [ ] **Step 1: Add `runVoidHooksList` helper**

After `runVoidHook` (after line 263), add:

```ts
/**
 * Run a void hook on an explicit list of hooks (fire-and-forget).
 */
async function runVoidHooksList<K extends PluginHookName>(
  hooks: PluginHookRegistration<K>[],
  hookName: K,
  event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
  ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
): Promise<void> {
  logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, void-list)`);
  const promises = hooks.map(async (hook) => {
    try {
      await (hook.handler as (event: unknown, ctx: unknown) => Promise<void>)(event, ctx);
    } catch (err) {
      handleHookError({ hookName, pluginId: hook.pluginId, error: err });
    }
  });
  await Promise.all(promises);
}
```

- [ ] **Step 2: Add `runModifyingHooksList` helper**

After `runModifyingHook` (after line 303), add:

```ts
/**
 * Run a modifying hook on an explicit list of hooks (sequential, merged results).
 */
async function runModifyingHooksList<K extends PluginHookName, TResult>(
  hooks: PluginHookRegistration<K>[],
  hookName: K,
  event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
  ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
  mergeResults?: (accumulated: TResult | undefined, next: TResult) => TResult,
): Promise<TResult | undefined> {
  logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, modifying-list)`);
  let result: TResult | undefined;
  for (const hook of hooks) {
    try {
      const handlerResult = await (
        hook.handler as (event: unknown, ctx: unknown) => Promise<TResult>
      )(event, ctx);
      if (handlerResult !== undefined && handlerResult !== null) {
        if (mergeResults && result !== undefined) {
          result = mergeResults(result, handlerResult);
        } else {
          result = handlerResult;
        }
      }
    } catch (err) {
      handleHookError({ hookName, pluginId: hook.pluginId, error: err });
    }
  }
  return result;
}
```

- [ ] **Step 3: Refactor `runVoidHook` and `runModifyingHook` to delegate to list helpers**

Replace the body of `runVoidHook` (lines 242-263) with:

```ts
async function runVoidHook<K extends PluginHookName>(
  hookName: K,
  event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
  ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
): Promise<void> {
  const hooks = getHooksForName(registry, hookName);
  if (hooks.length === 0) return;
  return runVoidHooksList(hooks, hookName, event, ctx);
}
```

Replace the body of `runModifyingHook` (lines 269-303) with:

```ts
async function runModifyingHook<K extends PluginHookName, TResult>(
  hookName: K,
  event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
  ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
  mergeResults?: (accumulated: TResult | undefined, next: TResult) => TResult,
): Promise<TResult | undefined> {
  const hooks = getHooksForName(registry, hookName);
  if (hooks.length === 0) return undefined;
  return runModifyingHooksList(hooks, hookName, event, ctx, mergeResults);
}
```

- [ ] **Step 4: Add `PluginHookMessageReceivedResult` import**

Add to the import from `./types.js`:

```ts
PluginHookMessageReceivedResult,
```

- [ ] **Step 5: Rewrite `runMessageReceived`**

Replace lines 583-592 with:

```ts
/**
 * Run message_received hooks.
 * Observer hooks (default) run in parallel fire-and-forget.
 * Blocking hooks (opt-in) are awaited sequentially and return a merged result.
 */
async function runMessageReceived(
  event: PluginHookMessageReceivedEvent,
  ctx: PluginHookMessageContext,
): Promise<PluginHookMessageReceivedResult | undefined> {
  const hooks = getHooksForName(registry, "message_received");
  if (hooks.length === 0) return undefined;

  const observerHooks = hooks.filter((h) => h.messageReceivedMode !== "blocking");
  const blockingHooks = hooks.filter((h) => h.messageReceivedMode === "blocking");

  if (observerHooks.length > 0) {
    void runVoidHooksList(observerHooks, "message_received", event, ctx);
  }

  if (blockingHooks.length === 0) return undefined;

  return runModifyingHooksList<"message_received", PluginHookMessageReceivedResult>(
    blockingHooks,
    "message_received",
    event,
    ctx,
    (acc, next) => ({
      cancel: acc?.cancel ?? next.cancel,
      blockReason: acc?.blockReason ?? next.blockReason,
      replyText: acc?.replyText ?? next.replyText,
    }),
  );
}
```

- [ ] **Step 6: Verify types compile**

Run: `pnpm tsgo`

Expected: no new errors.

- [ ] **Step 7: Commit**

```
scripts/committer "feat(plugins): split message_received into observer/blocking runtime paths" src/plugins/hooks.ts
```

---

## Task 4: Update test helpers in `src/plugins/hooks.test-helpers.ts`

**Files:**
- Modify: `src/plugins/hooks.test-helpers.ts`

- [ ] **Step 1: Add `priority` and `messageReceivedMode` support to `createMockPluginRegistry`**

The current hooks input type at line 5 only has `hookName` and `handler` — it does not accept `priority` (hardcoded to 0) or `messageReceivedMode`. Update the type and mapping:

```ts
export function createMockPluginRegistry(
  hooks: Array<{
    hookName: string;
    handler: (...args: unknown[]) => unknown;
    priority?: number;
    messageReceivedMode?: "observe" | "blocking";
  }>,
): PluginRegistry {
```

Update the `typedHooks` mapping at lines 34-40 to wire both through:

```ts
typedHooks: hooks.map((h) => ({
  pluginId: "test-plugin",
  hookName: h.hookName,
  handler: h.handler,
  priority: h.priority ?? 0,
  source: "test",
  messageReceivedMode: h.messageReceivedMode,
})),
```

This is critical: without `priority` wiring, the multi-handler priority merge test (Task 5, Test D) would silently ignore priority values and not validate priority-based ordering.

- [ ] **Step 2: Add `messageReceivedMode` support to `addTestHook`**

Update `addTestHook` parameter type and the push call to include:

```ts
export function addTestHook(params: {
  registry: PluginRegistry;
  pluginId: string;
  hookName: PluginHookRegistration["hookName"];
  handler: PluginHookRegistration["handler"];
  priority?: number;
  messageReceivedMode?: "observe" | "blocking";
}) {
  params.registry.typedHooks.push({
    pluginId: params.pluginId,
    hookName: params.hookName,
    handler: params.handler,
    priority: params.priority ?? 0,
    source: "test",
    messageReceivedMode: params.messageReceivedMode,
  } as PluginHookRegistration);
}
```

- [ ] **Step 3: Commit**

```
scripts/committer "test(plugins): add messageReceivedMode to test helpers" src/plugins/hooks.test-helpers.ts
```

---

## Task 5: Add runner-level tests in `src/plugins/wired-hooks-message.test.ts`

**Files:**
- Modify: `src/plugins/wired-hooks-message.test.ts`

- [ ] **Step 1: Write test A — observer mode stays non-blocking by default**

Add a new `describe("message_received hook runner")` block after the existing `message_sent` describe. This test registers an observer handler that returns a never-resolving promise and verifies `runMessageReceived` returns quickly with `undefined`.

```ts
describe("message_received hook runner", () => {
  it("observer mode (default) is non-blocking — slow handler does not block result", async () => {
    const handler = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "hello" },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
```

- [ ] **Step 2: Run test A to verify it passes**

Run: `pnpm test -- src/plugins/wired-hooks-message.test.ts -t "observer mode"`

Expected: PASS

- [ ] **Step 3: Write test B — observer return values are ignored**

```ts
  it("observer handler return value is ignored even if it returns cancel", async () => {
    const handler = vi.fn().mockReturnValue({ cancel: true, replyText: "blocked" });
    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "hello" },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
```

- [ ] **Step 4: Run test B to verify it passes**

Run: `pnpm test -- src/plugins/wired-hooks-message.test.ts -t "observer handler return value"`

Expected: PASS

- [ ] **Step 5: Write test C — blocking mode is awaited and returns cancel result**

```ts
  it("blocking handler is awaited and returns merged cancel result", async () => {
    const observerHandler = vi.fn().mockReturnValue(new Promise(() => {})); // slow observer
    const blockingHandler = vi.fn().mockResolvedValue({
      cancel: true,
      blockReason: "policy denied",
      replyText: "Blocked by policy.",
    });
    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler: observerHandler },
      { hookName: "message_received", handler: blockingHandler, messageReceivedMode: "blocking" },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "hello" },
      { channelId: "telegram" },
    );

    expect(observerHandler).toHaveBeenCalled();
    expect(blockingHandler).toHaveBeenCalled();
    expect(result).toEqual({
      cancel: true,
      blockReason: "policy denied",
      replyText: "Blocked by policy.",
    });
  });
```

- [ ] **Step 6: Write test D — multiple blocking handlers merge with first-defined-value-wins**

```ts
  it("multiple blocking handlers merge with higher-priority values winning", async () => {
    const highPriority = vi.fn().mockResolvedValue({
      cancel: true,
      blockReason: "high-priority reason",
    });
    const lowPriority = vi.fn().mockResolvedValue({
      cancel: false,
      blockReason: "low-priority reason",
      replyText: "low-priority reply",
    });
    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler: highPriority, priority: 10, messageReceivedMode: "blocking" },
      { hookName: "message_received", handler: lowPriority, priority: 1, messageReceivedMode: "blocking" },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "test" },
      { channelId: "discord" },
    );

    expect(result).toEqual({
      cancel: true,
      blockReason: "high-priority reason",
      replyText: "low-priority reply",
    });
  });
```

- [ ] **Step 7: Close the describe block**

```ts
});
```

- [ ] **Step 8: Run all runner-level tests**

Run: `pnpm test -- src/plugins/wired-hooks-message.test.ts`

Expected: all tests PASS

- [ ] **Step 9: Commit**

```
scripts/committer "test(plugins): add message_received observer/blocking runner tests" src/plugins/wired-hooks-message.test.ts
```

---

## Task 6: Wire blocking result into `src/auto-reply/reply/dispatch-from-config.ts`

**Files:**
- Modify: `src/auto-reply/reply/dispatch-from-config.ts:420-442`

- [ ] **Step 1: Replace fire-and-forget with awaited blocking call**

Replace lines 420-429 (the current fire-and-forget block):

```ts
// Trigger plugin hooks (fire-and-forget)
if (hookRunner?.hasHooks("message_received")) {
  fireAndForgetHook(
    hookRunner.runMessageReceived(
      toPluginMessageReceivedEvent(hookContext),
      toPluginMessageContext(hookContext),
    ),
    "dispatch-from-config: message_received plugin hook failed",
  );
}
```

with:

```ts
// Trigger plugin message_received hooks.
// Observer hooks fire in the background; blocking hooks are awaited.
const messageReceivedResult = hookRunner?.hasHooks("message_received")
  ? await hookRunner.runMessageReceived(
      toPluginMessageReceivedEvent(hookContext),
      toPluginMessageContext(hookContext),
    )
  : undefined;
```

- [ ] **Step 2: Add early-return on cancel after internal hooks bridge**

After the internal hooks bridge block (after line 442), and before `markProcessing()` (line 444), insert:

```ts
if (messageReceivedResult?.cancel) {
  if (messageReceivedResult.blockReason) {
    logVerbose(
      `dispatch-from-config: message_received blocked: ${messageReceivedResult.blockReason}`,
    );
  }
  const queuedFinal = messageReceivedResult.replyText
    ? await sendBindingNotice({ text: messageReceivedResult.replyText }, "terminal")
    : false;
  recordProcessed("completed", { reason: "message-received-cancelled" });
  markIdle("message_received_cancelled");
  return { queuedFinal, counts: dispatcher.getQueuedCounts() };
}
```

- [ ] **Step 3: Verify types compile**

Run: `pnpm tsgo`

Expected: no new errors.

- [ ] **Step 4: Commit**

```
scripts/committer "feat(dispatch): await blocking message_received hooks and early-return on cancel" src/auto-reply/reply/dispatch-from-config.ts
```

---

## Task 7: Add dispatch-level tests in `src/auto-reply/reply/dispatch-from-config.test.ts`

**Files:**
- Modify: `src/auto-reply/reply/dispatch-from-config.test.ts:44` (mock return type), and add new test block

- [ ] **Step 1: Update the mock return type for `runMessageReceived`**

Change line 44 from:

```ts
runMessageReceived: vi.fn(async () => {}),
```

to:

```ts
runMessageReceived: vi.fn(async () => undefined),
```

This aligns the mock with the new return type (`Promise<PluginHookMessageReceivedResult | undefined>`).

- [ ] **Step 2: Write test A — cancel without reply**

Add inside the existing `describe("dispatchReplyFromConfig", ...)` block (before the closing `});` at line 2673). Tests must use the established scaffolding: `setNoAbort()`, `createDispatcher()`, `emptyConfig`, and the `hookMocks` / `mocks` objects from the `vi.hoisted()` blocks.

The `sendBindingNotice` path for this non-originating-channel case falls through to `dispatcher.sendFinalReply` (terminal mode). Since we do not set `OriginatingChannel` different from `Provider`, the reply goes through the dispatcher directly.

```ts
  it("returns early without reply when message_received blocking hook cancels", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ From: "+1234567890", Body: "check this" });
    const replyResolver = vi.fn(async () => ({ text: "reply" }) satisfies ReplyPayload);

    hookMocks.runner.hasHooks.mockImplementation(
      (name: string) => name === "message_received",
    );
    hookMocks.runner.runMessageReceived.mockResolvedValue({
      cancel: true,
      blockReason: "policy-blocked",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
  });
```

- [ ] **Step 3: Write test B — cancel with reply text**

```ts
  it("sends terminal reply when message_received blocking hook cancels with replyText", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ From: "+1234567890", Body: "check this" });
    const replyResolver = vi.fn(async () => ({ text: "reply" }) satisfies ReplyPayload);

    hookMocks.runner.hasHooks.mockImplementation(
      (name: string) => name === "message_received",
    );
    hookMocks.runner.runMessageReceived.mockResolvedValue({
      cancel: true,
      blockReason: "policy-blocked",
      replyText: "Message blocked by policy.",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "Message blocked by policy.",
    });
    expect(result).toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
  });
```

- [ ] **Step 4: Run the dispatch tests**

Run: `pnpm test -- src/auto-reply/reply/dispatch-from-config.test.ts -t "message_received blocking"`

Expected: all tests PASS

- [ ] **Step 5: Commit**

```
scripts/committer "test(dispatch): add message_received blocking opt-in dispatch tests" src/auto-reply/reply/dispatch-from-config.test.ts
```

---

## Task 8: Full validation pass

- [ ] **Step 1: Run all hook tests**

Run: `pnpm test -- src/plugins/wired-hooks-message.test.ts`

Expected: all PASS

- [ ] **Step 2: Run all dispatch tests**

Run: `pnpm test -- src/auto-reply/reply/dispatch-from-config.test.ts`

Expected: all PASS

- [ ] **Step 3: Run broader plugin test suite**

Run: `pnpm test -- src/plugins`

Expected: all PASS

- [ ] **Step 4: Run type check**

Run: `pnpm tsgo`

Expected: no new errors from our changes

- [ ] **Step 5: Run format/lint**

Run: `pnpm check`

Expected: PASS (fix any formatting issues if needed)

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`

Expected: PASS (or only pre-existing unrelated failures)
