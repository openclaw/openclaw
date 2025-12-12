---
summary: "Refactor notes for the macOS gateway client: single shared websocket + follow-ups"
read_when:
  - Investigating duplicate/stale Gateway WS connections
  - Refactoring macOS gateway client architecture
  - Debugging noisy reconnect storms on gateway restart
---
# Gateway Refactor Notes (macOS client)

Last updated: 2025-12-12

This document captures the rationale and outcome of the macOS app’s Gateway client refactor: **one shared websocket connection per app process**, with an in-process event bus for server push frames.

Related docs:
- `docs/refactor/new-arch.md` (overall gateway protocol/server plan)
- `docs/gateway.md` (gateway operations/runbook)
- `docs/presence.md` (presence semantics and dedupe)
- `docs/mac/webchat.md` (WebChat surfaces and debugging)

---

## Background: what was wrong

Symptoms:
- Restarting the gateway produced a *storm* of reconnects/log spam (`gateway/ws in connect`, `hello`, `hello-ok`) and elevated `clients=` counts.
- Even with “one panel open”, the mac app could hold tens of websocket connections to `ws://127.0.0.1:18789`.

Root cause (historical bug):
- The mac app was repeatedly “reconfiguring” a gateway client on a timer (via health polling), creating a new websocket owner each time.
- Old websocket owners were not fully torn down and could keep watchdog/tick tasks alive, leading to **connection accumulation** over time.

---

## What changed

- **One socket owner:** `GatewayConnection.shared` is the only supported entry point for gateway RPC.
- **No global notifications:** server push frames are delivered via `GatewayConnection.shared.subscribe(...) -> AsyncStream<GatewayPush>` (no `NotificationCenter` fan-out).
- **No tunnel side effects:** `GatewayConnection` does not create/ensure SSH tunnels in remote mode; it consumes the already-established forwarded port.

---

## Current architecture (as of 2025-12-12)

Goal: enforce the invariant **“one gateway websocket per app process (per effective config)”**.

Key elements:
- `GatewayConnection.shared` owns the one websocket and is the *only* supported entry point for app code that needs gateway RPC.
- Consumers (e.g. Control UI, Agent RPC, SwiftUI WebChat) call `GatewayConnection.shared.request(...)` and do not create their own sockets.
- If the effective connection config changes (local ↔ remote tunnel port, token change), `GatewayConnection` replaces the underlying connection.
- The transport (`GatewayChannelActor`) is an internal detail and forwards push frames back into `GatewayConnection`.
- Server-push frames are delivered via `GatewayConnection.shared.subscribe(...) -> AsyncStream<GatewayPush>` (in-process event bus).

Notes:
- Remote mode requires an SSH control tunnel. `GatewayConnection` **does not** start tunnels; it consumes the already-established forwarded port (owned by `ConnectionModeCoordinator` / `RemoteTunnelManager`).

---

## Design constraints / principles

- **Single ownership:** Exactly one component owns the actual socket and reconnect policy.
- **Explicit config changes:** Recreate/reconnect only when config changes, not as a side effect of periodic work.
- **No implicit fan-out sockets:** Adding new UI features must not accidentally add new persistent gateway connections.
- **Testable seams:** Connection config and websocket session creation should be overridable in tests.

---

## Status / remaining work

- ✅ One shared websocket per app process (per config)
- ✅ Event streaming moved into `GatewayConnection` (`AsyncStream<GatewayPush>`) and replays latest snapshot to new subscribers
- ✅ `NotificationCenter` removed for in-process gateway events (ControlChannel / Instances / WebChatSwiftUI)
- ✅ Remote tunnel lifecycle is not started implicitly by random RPC calls
- ✅ Payload decoding helpers extracted so UI adapters stay thin
- ✅ Dedicated resolved-endpoint publisher for remote mode (`GatewayEndpointStore`)

---

## Testing strategy (what we want to cover)

Minimum invariants:
- Repeated requests under the same config do **not** create additional websocket tasks.
- Concurrent requests still create **exactly one** websocket and reuse it.
- Shutdown prevents any reconnect loop after failures.
- Config changes (token / endpoint) cancel the old socket and reconnect once.

Nice-to-have integration coverage:
- Multiple “consumers” (Control UI + Agent RPC + SwiftUI WebChat) all call through the shared connection and still produce only one websocket.

Additional coverage added (macOS):
- Subscribing after connect replays the latest snapshot.
- Sequence gaps emit an explicit `GatewayPush.seqGap(...)` before the corresponding event.

---

## Debug notes (operational)

When diagnosing “too many connections”:
- Prefer counting actual TCP connections on port 18789 and grouping by PID to see which process is holding sockets.
- Gateway `--verbose` prints *every* connect/hello and event broadcast; use it only when needed and filter output if you’re just sanity-checking.
