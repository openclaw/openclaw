---
summary: "Inbound event helpers for channel plugins: context building, shared runner orchestration, session record, and prepared reply dispatch"
title: "Channel inbound API"
read_when:
  - You are building or refactoring a messaging channel plugin receive path
  - You need shared inbound context construction, session recording, or prepared reply dispatch
  - You are migrating old channel turn helpers to inbound/message APIs
---

Channel plugins should model receive paths with inbound and message nouns:

```text
platform event -> inbound facts/context -> agent reply -> message delivery
```

Use `openclaw/plugin-sdk/channel-inbound` for inbound event normalization,
formatting, roots, and orchestration. Use
`openclaw/plugin-sdk/channel-outbound` for native
send, receipt, durable delivery, and live preview behavior.

## Core Helpers

```ts
import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
  dispatchChannelInboundReply,
} from "openclaw/plugin-sdk/channel-inbound";
```

- `buildChannelInboundEventContext(...)`: project normalized channel facts into
  the prompt/session context.
- `runChannelInboundEvent(...)`: run ingest, classify, preflight, resolve,
  record, dispatch, and finalize for one inbound platform event.
- `dispatchChannelInboundReply(...)`: record and dispatch an already assembled
  inbound reply with a delivery adapter.

The injected plugin runtime exposes the same high-level helpers under
`runtime.channel.inbound.*` for bundled/native channels that already receive the
runtime object.

```ts
await runtime.channel.inbound.run({
  channel: "demo",
  accountId,
  raw: platformEvent,
  adapter: {
    ingest: normalizePlatformEvent,
    resolveTurn: resolveInboundReply,
  },
});
```

Compatibility dispatchers should assemble `dispatchChannelInboundReply(...)`
inputs and keep platform delivery in the delivery adapter. New send paths should
prefer message adapters and durable message helpers.

## Routing and live bindings

CLI binding edits (`openclaw agents bind add/remove`, `agents add`, and any
config write touching `bindings[]`, `agents.*`, or `routing.*`) must take effect
on the next inbound message **without a gateway restart**. The reload planner
intentionally classifies these config paths as `kind: "none"` in
`src/gateway/config-reload-plan.ts` so that channel restarts and heartbeat
restarts are not triggered for routing-only edits; the contract is that channel
plugins re-resolve routing per inbound against a fresh runtime cfg.

What this means for channel plugin authors:

- Do **not** capture the `cfg` reference handed to your plugin at `start(...)`
  / `register(...)` time and reuse it inside long-lived inbound handlers. That
  reference becomes stale the moment the next config write swaps the runtime
  snapshot.
- On every inbound event, fetch the current cfg via
  `getRuntimeConfig()` from `openclaw/plugin-sdk/runtime-config-snapshot` (or
  `ctx.getRuntimeConfig()` where the SDK injects it). Pass that fresh
  reference into `resolveAgentRoute(...)` and any downstream dispatch.
- Do **not** use the deprecated `api.runtime.config.loadConfig()` on inbound
  paths; it warns at runtime and is exempt from the runtime-owned snapshot
  refresh. See `## Config loading and writes` in
  [`sdk-runtime.md`](./sdk-runtime.md) for the broader runtime config contract.

The routing layer caches evaluated bindings in a
`WeakMap<OpenClawConfig, EvaluatedBindingsCache>` keyed by cfg reference (see
`src/routing/resolve-route.ts`). A stale cfg reference returns a stale routing
result by construction — there is no time-based invalidation. Per-inbound
`getRuntimeConfig()` is the single mechanism that keeps the WeakMap honest.

Reference implementations in this tree:

- `extensions/telegram/src/bot-handlers.runtime.ts` — `cfg:
  telegramDeps.getRuntimeConfig()` // "Fresh config for bindings lookup"
- `extensions/qqbot/src/engine/gateway/active-cfg.ts` — `ActiveCfgProvider`
  helper, used per inbound in `gateway.ts` (added in #73567 to close the
  same-shape regression #69546)

A channel plugin that violates this contract will appear to work in tests
(static cfg) and on a fresh gateway, then silently route messages to the wrong
agent (or fall back to `agent:main`) after any CLI binding edit, until the
gateway is restarted.

## Migration

The old `runtime.channel.turn.*` runtime aliases were removed. Use:

- `runtime.channel.inbound.run(...)` for raw inbound events.
- `runtime.channel.inbound.dispatchReply(...)` for assembled reply contexts.
- `runtime.channel.inbound.buildContext(...)` for inbound context payloads.
- `runtime.channel.inbound.runPreparedReply(...)` only for channel-owned prepared
  dispatch paths that already assemble their own dispatch closure.

New plugin code should not introduce `turn`-named channel APIs. Keep model or
agent turn vocabulary inside agent/provider code; channel plugins use inbound,
message, delivery, and reply terms.
