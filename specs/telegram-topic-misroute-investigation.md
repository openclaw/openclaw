# Telegram Topic Misroute Investigation

## Scope

Observed misroute:

- Intended/origin session key: `agent:main:telegram:group:-1003774691294:topic:47`
- Intended/origin session id: `fd9b66a7-ebbf-4a7b-8415-b5d366379cd2`
- Intended delivery context: Telegram group `-1003774691294`, thread/topic `47`
- Observed/misrouted session key: `agent:main:telegram:group:-1003774691294:topic:2175`
- Observed/misrouted session id: `942dc58d-ce55-4790-89f1-05d4ad12757d`
- Observed delivery context: Telegram group `-1003774691294`, thread/topic `2175`

Misrouted text:

> The review-worker spawn finished successfully.
>
> Active review workers now:
>
> • Ren 6687c550 for PR #380
> • Stimpy f667e0d7 for PR #381
>
> They’re both up in fresh openclaw worktrees and working from the review-pr flow.

## Conclusion

This does **not** look like a Telegram topic session-key derivation bug. The topic-scoped session machinery correctly distinguishes topic `47` from topic `2175`.

This looks most like a **completion-event routing bug caused by mutable last-route contamination**:

- a delayed completion event is associated with session key `agent:main:telegram:group:-1003774691294:topic:47`
- but the delayed event does **not** preserve the original topic delivery context
- when the completion is delivered later, it reuses whatever delivery route is currently stored on that session
- if that stored route has drifted to Telegram topic `2175`, the completion can land in `2175` even though the originating session key was still `...:topic:47`

So the best classification is:

- not a raw session binding bug
- not primarily a Telegram send bug
- yes, a completion-event routing bug
- enabled by last-thread / last-route contamination

## Why The Session Keys Themselves Look Correct

Telegram topic routing is explicitly topic-qualified:

- `extensions/telegram/src/bot/helpers.ts` builds group peer ids as `<chatId>:topic:<threadId>`
- `extensions/telegram/src/conversation-route.ts` uses that peer id to resolve the route and session key
- `extensions/telegram/src/bot-message-context.session.ts` records inbound last-route updates back to the topic session, including topic-qualified `to` values like `telegram:<chatId>:topic:<threadId>`

That means topic `47` and topic `2175` should naturally produce different session keys and different inbound last-route updates. I did not find a source path that would collapse those two topic keys together.

## Strongest Suspected Wrong-Target Path

### 1. Background exec completion enqueues by `sessionKey` only

In `src/agents/bash-tools.exec-runtime.ts`, `maybeNotifyOnExit(...)` does this:

- builds a completion summary
- calls `enqueueSystemEvent(summary, { sessionKey, trusted: false })`
- wakes heartbeat with `requestHeartbeatNow(...)`

Critically, it does **not** attach a `deliveryContext`.

`emitExecSystemEvent(...)` in the same file has the same shape: it queues by `sessionKey` and optional `contextKey`, but not by `deliveryContext`.

### 2. System events can carry delivery context, but exec completions do not

`src/infra/system-events.ts` supports per-event `deliveryContext`, and heartbeat preflight explicitly reads it through `resolveSystemEventDeliveryContext(...)`.

That means the infrastructure already has the right abstraction, but exec completion events are not using it.

### 3. Heartbeat delivery then falls back to mutable session routing state

`src/infra/heartbeat-runner.ts` reads pending system events, resolves any event-scoped delivery context, and passes that into `resolveHeartbeatDeliveryTarget(...)`.

`src/infra/outbound/targets.ts` and `src/infra/outbound/targets-session.ts` then resolve the delivery target from:

- explicit turn-source context, if any
- otherwise the session entry’s stored `deliveryContext` / `lastTo` / `lastThreadId`

That fallback is where the contamination can happen.

## Important Telegram-Specific Detail

Heartbeat mode intentionally avoids inheriting a stale `threadId`, but that is not enough to protect Telegram forum topics.

Reason:

- Telegram topic routing can live in the raw `to` value itself, for example `telegram:-1003774691294:topic:2175`
- `resolveSessionDeliveryTarget(...)` can still reuse that raw topic-qualified `to`
- `extensions/telegram/src/send.ts` parses the topic out of `to` itself before sending

So even if `threadId` is blank at heartbeat time, a contaminated topic-qualified `to` can still route the message into topic `2175`.

That matches the observed symptom very well.

## Most Likely Concrete Root Cause

The likely failure chain is:

1. Some background/async operation was started from session key `agent:main:telegram:group:-1003774691294:topic:47`.
2. Its completion path queued only `sessionKey`, not the origin delivery context for topic `47`.
3. Before the completion was delivered, the session’s mutable stored route had become topic `2175` or otherwise resolved to `telegram:-1003774691294:topic:2175`.
4. The delayed completion reused that mutable route and delivered into topic `2175`.

I did **not** identify the earlier write that contaminated the stored route to `2175`. That may be a separate bug or race. But the completion-event path is the part that makes the misroute possible even when the original session key was still `...:topic:47`.

## Exact Suspected Source Files / Functions

Primary suspects:

- `src/agents/bash-tools.exec-runtime.ts`
  - `maybeNotifyOnExit(...)`
  - `emitExecSystemEvent(...)`
- `src/infra/system-events.ts`
  - `enqueueSystemEvent(...)`
  - `resolveSystemEventDeliveryContext(...)`
- `src/infra/heartbeat-runner.ts`
  - `resolveHeartbeatPreflight(...)`
- `src/infra/outbound/targets.ts`
  - `resolveHeartbeatDeliveryTarget(...)`
- `src/infra/outbound/targets-session.ts`
  - `resolveSessionDeliveryTarget(...)`
- `extensions/telegram/src/send.ts`
  - `sendMessageTelegram(...)` parses topic-qualified `to` targets directly

Files I checked and ruled out as the primary source:

- `extensions/telegram/src/conversation-route.ts`
- `extensions/telegram/src/bot-message-context.session.ts`
- `src/routing/resolve-route.ts`
- `src/agents/subagent-spawn.ts`
- `src/agents/subagent-announce-delivery.ts`

The subagent completion path appears to preserve requester origin, including thread id, and is less likely to explain this specific topic swap.

## Recommended Fix

Safe, surgical fix to implement later:

1. Capture immutable origin `deliveryContext` when an async exec/background job is created.
2. Store that origin context on the process session or pass it directly into completion event enqueueing.
3. In `maybeNotifyOnExit(...)` and `emitExecSystemEvent(...)`, call `enqueueSystemEvent(...)` with both:
   - `sessionKey`
   - `deliveryContext` for the original requester route
4. Add a regression test:
   - start async exec from Telegram topic `47`
   - mutate the session’s stored last route to topic `2175`
   - complete the exec
   - assert that the completion still delivers to topic `47`

That keeps delayed completions pinned to the originating conversation instead of a mutable later session route.

## Bottom Line

The exact source session key `agent:main:telegram:group:-1003774691294:topic:47` could still have been the correct originating session while the completion message landed in topic `2175`.

The most plausible reason is that async exec completion delivery is keyed to the session but not pinned to the original Telegram topic delivery context, so later session-route drift can redirect the completion into the wrong topic.
