---
summary: "Refactor notes for the macOS gateway client: single shared websocket + follow-ups"
read_when:
  - Investigating duplicate/stale Gateway WS connections
  - Refactoring macOS gateway client architecture
  - Debugging noisy reconnect storms on gateway restart
---
# Gateway Refactor Notes (macOS client)

Last updated: 2025-12-12

This document captures the rationale and direction for the macOS app’s Gateway client refactor: **one shared websocket connection per app process**, plus follow-up improvements to simplify lifetimes and reduce “hidden” reconnection behavior.

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

## Current architecture (as of 2025-12-12)

Goal: enforce the invariant **“one gateway websocket per app process (per effective config)”**.

Key elements:
- `GatewayConnection.shared` owns the one websocket and is the *only* supported entry point for app code that needs gateway RPC.
- Consumers (e.g. Control UI, Agent RPC, SwiftUI WebChat) call `GatewayConnection.shared.request(...)` and do not create their own sockets.
- If the effective connection config changes (local ↔ remote tunnel port, token change), `GatewayConnection` replaces the underlying connection.
- Server-push frames are delivered via `GatewayConnection.shared.subscribe(...) -> AsyncStream<GatewayPush>`, which is the in-process event bus (no `NotificationCenter`).

Notes:
- Remote mode requires an SSH control tunnel. `GatewayConnection` **does not** start tunnels; it consumes the already-established forwarded port (owned by `ConnectionModeCoordinator` / `RemoteTunnelManager`).

---

## Design constraints / principles

- **Single ownership:** Exactly one component owns the actual socket and reconnect policy.
- **Explicit config changes:** Recreate/reconnect only when config changes, not as a side effect of periodic work.
- **No implicit fan-out sockets:** Adding new UI features must not accidentally add new persistent gateway connections.
- **Testable seams:** Connection config and websocket session creation should be overridable in tests.

---

## Follow-up refactors (recommended)

### Status (as of 2025-12-12)

- ✅ One shared websocket per app process (per config)
- ✅ Event streaming moved into `GatewayConnection` (`AsyncStream<GatewayPush>`)
- ✅ `NotificationCenter` removed for in-process gateway events
- ✅ `GatewayConnection` no longer implicitly starts the remote control tunnel
- ⏳ Further separation of concerns (polish/cleanup): push parsing helpers + clearer UI adapters
- ⏳ Optional: a dedicated “resolved endpoint” publisher for remote mode (to make mode transitions observable)

### 1) Move event streaming into `GatewayConnection` (done)

Implemented:
- `GatewayChannelActor` no longer posts global notifications; it forwards pushes to `GatewayConnection` via a callback.
- `GatewayConnection` fans out pushes via `subscribe(...) -> AsyncStream<GatewayPush>` and replays the latest snapshot to new subscribers.

### 2) Replace `NotificationCenter` for in-process events (done)

Implemented:
- `ControlChannel`, `InstancesStore`, and SwiftUI WebChat now subscribe to `GatewayConnection` directly.
- This removed the risk of leaking `NotificationCenter` observer tokens when views/controllers churn.

### 3) Separate control-plane vs chat-plane concerns (partially done)

As features grow, split responsibilities:
- **RPC layer**: request/response, retries, timeouts.
- **Event bus**: typed gateway events with buffering/backpressure.
- **UI adapters**: user-facing state and error mapping.

This reduces the risk that “a UI refresh” causes connection or tunnel side effects.

Notes:
- The RPC layer and event bus are now centralized in `GatewayConnection`.
- There’s still room to extract small helpers for decoding specific event payloads (agent/chat/presence) so UI code stays thin.

### 4) Centralize tunnel lifecycle (remote mode) (done for GatewayConnection)

Previously, “first request wins” could implicitly start/ensure a tunnel (via `GatewayConnection`’s default config provider).

Now:
- `GatewayConnection` uses the already-running forwarded port from `RemoteTunnelManager` and will error if remote mode is enabled but no tunnel is active.
- Remote tunnel lifecycle is owned by mode/application coordinators (e.g. `ConnectionModeCoordinator`), not by incidental RPC calls.

Future improvement:
- A dedicated coordinator that owns remote tunnel lifecycle and publishes a resolved endpoint.
- `GatewayConnection` consumes that endpoint rather than calling into tunnel code itself.

This makes remote mode behavior easier to reason about (and test).

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
