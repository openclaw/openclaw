# `message_received` Opt-In Blocking Handoff

## Repository / Branch

- Upstream repo: `https://github.com/openclaw/openclaw`
- Fork: `https://github.com/nickfujita/openclaw`
- Working branch: `nick/message-received-blocking-opt-in`
- Handoff date: `2026-03-23`

## Purpose of This Document

This file is a zero-context handoff for implementing an **opt-in blocking mode**
for the `message_received` plugin hook in OpenClaw.

A future agent/session should be able to start from this file alone and:

1. understand the problem,
2. understand why the current upstream behavior is insufficient,
3. implement the change without breaking existing plugins,
4. add tests,
5. validate the result, and
6. prepare a clean PR.

This document is the source of truth. Do **not** assume any prior chat context.

## Problem Summary

OpenClaw currently exposes a `message_received` plugin hook, but it is not
usable for async policy enforcement because the inbound dispatch path does not
wait for it.

That means a plugin can observe the inbound message, but cannot reliably:

- perform an async remote policy check,
- block agent execution before LLM tokens are consumed,
- optionally send a direct block reply instead of invoking the agent.

This is a problem for security plugins that proxy inbound content to a remote
policy service before allowing the message into the normal reply pipeline.

## Current Upstream Behavior

These are the relevant facts in upstream `main` at the time this handoff was
written:

### 1. `message_received` is typed as an observer hook, not a blocking hook

In [`src/plugins/types.ts`](../../src/plugins/types.ts), the handler signature
for `message_received` returns `Promise<void> | void`.

That means there is no typed way to return:

- `cancel`
- `block`
- `replyText`
- `blockReason`

### 2. The inbound dispatch path does not wait for `message_received`

In [`src/auto-reply/reply/dispatch-from-config.ts`](../../src/auto-reply/reply/dispatch-from-config.ts),
the `message_received` hook is triggered via `fireAndForgetHook(...)` and then
the message processing continues immediately.

That is the concrete reason async policy checks cannot gate inbound flow today.

### 3. The hook runner itself can await async handlers, but this hook is wired as fire-and-forget

In [`src/plugins/hooks.ts`](../../src/plugins/hooks.ts), `runVoidHook(...)`
awaits its internal `Promise.all(...)`. However, `runMessageReceived(...)` is
implemented as a `runVoidHook("message_received", ...)` wrapper, and the caller
does not await it in the inbound dispatch path.

### 4. `before_message_write` is not a substitute

`before_message_write` is synchronous by design. It can block transcript
persistence, but:

- it is too late for inbound policy gating,
- it does not allow async work,
- it does not stop the main inbound dispatch flow before LLM execution.

### 5. Outbound and tool hooks already demonstrate the desired pattern

There are existing examples of awaited, result-bearing hooks:

- `message_sending`
- `before_tool_call`

Those hooks already support the kind of sequential, async, policy-returning
behavior we want to mirror for the blocking subset of `message_received`.

## Design Goal

Implement **opt-in blocking support** for `message_received` while preserving
the existing default behavior for all current plugins.

The key design requirement is:

- **existing `message_received` handlers must remain observer-only by default**
- **only handlers that explicitly opt in should become awaited/blocking**

This avoids a behavior break for plugins that currently rely on the hook being
non-blocking and fire-and-forget.

## Non-Goals

This change should **not** try to solve everything at once.

Do **not** expand scope to:

- add a brand new `before_dispatch` hook,
- solve `inbound_claim` broadcast behavior,
- add inbound content mutation unless absolutely necessary,
- redesign the whole plugin hook system,
- change fail-open/fail-closed semantics globally,
- fix unrelated outbound hook gaps.

Keep this PR narrow: **opt-in blocking for `message_received`**.

## Proposed Behavior

### Default mode: unchanged

If a plugin registers:

```ts
api.on("message_received", async (event, ctx) => {
  // observe only
});
```

then behavior remains the same:

- the handler runs asynchronously,
- it is not awaited by the inbound dispatch path,
- its return value is ignored.

### Blocking mode: new opt-in behavior

If a plugin registers:

```ts
api.on("message_received", async (event, ctx) => {
  const decision = await remotePolicyCheck(event);
  if (!decision.allow) {
    return {
      cancel: true,
      blockReason: "remote policy denied inbound message",
      replyText: "Your message was blocked by policy.",
    };
  }
}, { mode: "blocking" });
```

then behavior becomes:

1. OpenClaw awaits that handler before continuing inbound dispatch.
2. If it returns `cancel: true`, the normal agent dispatch is aborted.
3. If `replyText` is present, OpenClaw sends that reply using the existing
   direct-reply path and returns early.
4. If `replyText` is absent, OpenClaw silently drops the inbound message and
   returns early.

## Recommended Public API Shape

### New result type

Add a result type for `message_received`:

```ts
export type PluginHookMessageReceivedResult = {
  cancel?: boolean;
  blockReason?: string;
  replyText?: string;
};
```

Rationale:

- `cancel` mirrors `message_sending` semantics.
- `blockReason` is useful for diagnostics/logging.
- `replyText` allows a clean user-facing rejection without inventing another
  hook or special case.

### New typed hook registration options

Introduce a typed options shape for `api.on(...)`, something like:

```ts
export type PluginHookMessageReceivedMode = "observe" | "blocking";

export type OpenClawPluginTypedHookOptions<K extends PluginHookName> = {
  priority?: number;
} & (K extends "message_received"
  ? { mode?: PluginHookMessageReceivedMode }
  : Record<never, never>);
```

Then update `OpenClawPluginApi["on"]` to use:

```ts
on: <K extends PluginHookName>(
  hookName: K,
  handler: PluginHookHandlerMap[K],
  opts?: OpenClawPluginTypedHookOptions<K>,
) => void;
```

Rationale:

- keeps the extra option scoped to `message_received`,
- preserves type safety,
- avoids pretending other hooks support `mode`.

### Internal registration metadata

Store mode metadata on typed hook registrations, e.g.:

```ts
messageReceivedMode?: "observe" | "blocking";
```

This should live on the internal typed registration object in
`src/plugins/types.ts` / `src/plugins/registry.ts`.

It is fine if this field is only meaningful for `message_received`.

## Recommended Runtime Semantics

### Core principle

Split `message_received` handlers into two buckets:

1. **observer handlers**
2. **blocking handlers**

Then:

- run observer handlers in the historical fire-and-forget style,
- run blocking handlers sequentially and await them,
- return a merged blocking result to the caller.

### Why split instead of changing all handlers?

Because changing all `message_received` handlers to awaited/blocking would be a
behavioral break:

- latency changes,
- ordering changes,
- side-effect timing changes,
- possible accidental flow control changes for existing plugins.

The split preserves backward compatibility.

## Suggested Merge Semantics for Multiple Blocking Handlers

Recommendation: **first defined value wins by priority order**.

Since hooks are already sorted by descending priority, a higher-priority hook
should retain control if it defines:

- `cancel`
- `blockReason`
- `replyText`

That means the merge should look like:

```ts
(acc, next) => ({
  cancel: acc?.cancel ?? next.cancel,
  blockReason: acc?.blockReason ?? next.blockReason,
  replyText: acc?.replyText ?? next.replyText,
})
```

Do **not** make a lower-priority hook “un-cancel” a higher-priority decision.

## Files to Change

### 1. `src/plugins/types.ts`

Make these changes:

- add `PluginHookMessageReceivedResult`
- add `PluginHookMessageReceivedMode`
- add `OpenClawPluginTypedHookOptions<K>`
- change `OpenClawPluginApi["on"]` to use the new typed options
- change `PluginHookHandlerMap["message_received"]` to allow returning the new result
- extend `PluginHookRegistration` with internal mode metadata

### 2. `src/plugins/registry.ts`

Make these changes:

- import the new typed hook options type
- update `registerTypedHook(...)` signature to accept the typed options
- when `hookName === "message_received"` and `opts.mode === "blocking"`,
  persist that mode on the stored typed hook registration
- otherwise leave the field undefined

### 3. `src/plugins/hooks.ts`

This is the key runtime file.

Recommended refactor:

#### A. Extract reusable helper(s)

Refactor the existing helper logic so it can operate on an explicit list of
hooks, not only “all hooks with a given name”.

Suggested helpers:

- `runVoidHooksList(...)`
- `runModifyingHooksList(...)`

Then keep:

- `runVoidHook(...)` as a thin wrapper around `getHooksForName(...)`
- `runModifyingHook(...)` as a thin wrapper around `getHooksForName(...)`

This allows `message_received` to reuse the same core logic as
`message_sending`, just on a filtered subset.

#### B. Update `runMessageReceived(...)`

Recommended logic:

1. get all `message_received` hooks
2. partition into:
   - observer hooks: `messageReceivedMode !== "blocking"`
   - blocking hooks: `messageReceivedMode === "blocking"`
3. fire observer hooks in the background
4. if no blocking hooks, return `undefined`
5. run blocking hooks sequentially with merge semantics
6. return the merged `PluginHookMessageReceivedResult | undefined`

Important:

- observer hooks must remain effectively fire-and-forget
- blocking hooks must be awaited
- blocking return values from observer hooks must be ignored

### 4. `src/auto-reply/reply/dispatch-from-config.ts`

Change the inbound flow so that:

1. `runMessageReceived(...)` is awaited
2. internal message hooks still fire in their existing way
3. if the returned result has `cancel: true`:
   - optionally log `blockReason`
   - if `replyText` exists, send it via the existing helper path
   - return early before `markProcessing()` and before the normal reply flow

#### Important implementation detail

Reuse the existing `sendBindingNotice(...)` helper if possible.

Why:

- it already knows how to route a reply to the originating channel when needed
- it already handles “terminal” reply behavior cleanly
- it reduces new branching logic

If this works cleanly, use:

```ts
await sendBindingNotice({ text: result.replyText }, "terminal")
```

This is preferred over inventing a new outbound reply mechanism.

### 5. `src/plugins/hooks.test-helpers.ts`

Extend the helper registry builders so tests can create a typed hook
registration with:

```ts
messageReceivedMode: "blocking"
```

This is needed for runner-level tests.

### 6. `src/plugins/wired-hooks-message.test.ts`

Add runner tests for the new behavior.

Minimum useful tests:

#### Test A: observer mode stays non-blocking by default

- register a `message_received` handler with no `mode`
- make it return a never-resolving promise or delayed promise
- verify `runMessageReceived(...)` returns quickly with `undefined`

#### Test B: observer return values are ignored

- register a `message_received` observer that returns `{ cancel: true }`
- verify the result is still `undefined`

#### Test C: blocking mode is awaited and returns cancel result

- register one observer hook and one blocking hook
- make observer slow and blocking immediate
- verify:
  - observer is started
  - blocking result is returned
  - the returned object contains `cancel`, `blockReason`, and `replyText`

### 7. `src/auto-reply/reply/dispatch-from-config.test.ts`

Add dispatch-level tests.

Minimum useful tests:

#### Test A: cancel without reply

- mock `runMessageReceived()` to return `{ cancel: true, blockReason: "..." }`
- verify:
  - `replyResolver` is not called
  - no final reply is sent
  - function returns early

#### Test B: cancel with reply

- mock `runMessageReceived()` to return:

```ts
{
  cancel: true,
  blockReason: "policy-blocked",
  replyText: "Message blocked by policy",
}
```

- verify:
  - `replyResolver` is not called
  - the dispatcher sends the terminal reply
  - the function returns early

## Explicit Implementation Notes

### Preserve these existing behaviors

- `message_received` remains available as an observer hook with no extra config
- existing plugins that do not opt in keep old semantics
- internal hooks remain independent from plugin hook blocking logic
- no new global config should be introduced

### Do not do this

- do not change all `message_received` hooks to awaited
- do not change `before_message_write`
- do not convert this into a `before_dispatch` PR
- do not make the entire hook system fail-closed
- do not add inbound content mutation in the same PR

### Keep the PR small

This should be a narrow plugin-hook/runtime change, not a platform-wide policy
framework overhaul.

## Suggested Pseudocode

### `src/plugins/hooks.ts`

```ts
async function runMessageReceived(event, ctx) {
  const hooks = getHooksForName(registry, "message_received");
  if (hooks.length === 0) return undefined;

  const observerHooks = hooks.filter((h) => h.messageReceivedMode !== "blocking");
  const blockingHooks = hooks.filter((h) => h.messageReceivedMode === "blocking");

  if (observerHooks.length > 0) {
    void runVoidHooksList(observerHooks, "message_received", event, ctx);
  }

  if (blockingHooks.length === 0) {
    return undefined;
  }

  return runModifyingHooksList(
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

### `src/auto-reply/reply/dispatch-from-config.ts`

```ts
const messageReceivedResult = hookRunner?.hasHooks("message_received")
  ? await hookRunner.runMessageReceived(event, ctx)
  : undefined;

if (sessionKey) {
  fireAndForgetHook(triggerInternalHook(...), ...);
}

if (messageReceivedResult?.cancel) {
  if (messageReceivedResult.blockReason) {
    logVerbose(`... ${messageReceivedResult.blockReason}`);
  }

  const queuedFinal = messageReceivedResult.replyText
    ? await sendBindingNotice({ text: messageReceivedResult.replyText }, "terminal")
    : false;

  recordProcessed("completed", { reason: "message-received-cancelled" });
  return { queuedFinal, counts: dispatcher.getQueuedCounts() };
}
```

## Validation Plan

Once implemented on a healthy machine/session:

### 1. Install dependencies

```bash
corepack pnpm install --frozen-lockfile
```

### 2. Run the targeted tests first

Use the direct vitest entrypoint if `pnpm exec vitest` is flaky:

```bash
node ./node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts \
  src/plugins/wired-hooks-message.test.ts \
  src/auto-reply/reply/dispatch-from-config.test.ts
```

If the repo’s package-manager environment is healthy, this should also work:

```bash
corepack pnpm exec vitest run --config vitest.unit.config.ts \
  src/plugins/wired-hooks-message.test.ts \
  src/auto-reply/reply/dispatch-from-config.test.ts
```

### 3. Optionally run additional plugin-hook coverage

Useful follow-up runs:

```bash
node ./node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts src/plugins
node ./node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts src/auto-reply/reply
```

### 4. Review the final diff

```bash
git diff -- \
  src/plugins/types.ts \
  src/plugins/registry.ts \
  src/plugins/hooks.ts \
  src/plugins/hooks.test-helpers.ts \
  src/plugins/wired-hooks-message.test.ts \
  src/auto-reply/reply/dispatch-from-config.ts \
  src/auto-reply/reply/dispatch-from-config.test.ts
```

## PR Framing Guidance

If this is turned into a PR, frame it as:

> Add an opt-in blocking mode for `message_received` so security and policy
> plugins can perform async inbound checks before agent dispatch, while
> preserving existing fire-and-forget behavior for current observer hooks.

Key points to emphasize:

- backward compatible by default
- minimal surface-area increase
- reuses existing hook-runner patterns
- directly solves a real plugin integration need

## Caveats / Environment Notes

During the original implementation attempt on this machine/session:

- the fork was created successfully,
- the branch was created successfully,
- a draft code implementation was started locally,
- test verification was interrupted by local environment instability,
- package-manager / runtime linkage issues appeared unrelated to the intended
  code change.

Therefore:

- **do not trust any unverified local working-tree state from that earlier session**
- **treat this document as the authoritative handoff**

## If Starting Fresh

On a new machine, a good clean sequence is:

```bash
git clone https://github.com/nickfujita/openclaw.git
cd openclaw
git checkout nick/message-received-blocking-opt-in
corepack pnpm install --frozen-lockfile
```

Then implement the file changes described above.

## Final Recommendation

Implement the narrow opt-in version first.

If maintainers later want a cleaner universal interception story, that can be a
separate `before_dispatch` proposal. For now, this PR should stay disciplined:

- add result support,
- add opt-in blocking mode,
- wire it into inbound dispatch,
- prove it with tests,
- avoid broader architecture churn.
