---
summary: "Refactor notes for the macOS gateway client typed API migration (Dec 2025)."
read_when:
  - Refactoring macOS gateway client or typed gateway methods
  - Auditing agent routing or channel semantics
---

# Gateway Client Refactor (Dec 2025)

Goal: remove stringly-typed gateway calls from the macOS app, centralize routing/channel semantics, and improve error handling.

## Progress

- [x] Fold legacy “AgentRPC” into `GatewayConnection` (single layer; no separate client object).
- [x] Typed gateway API: `GatewayConnection.Method` + `requestDecoded/requestVoid` + typed helpers (status/agent/chat/cron/etc).
- [x] Centralize agent routing/channel semantics via `GatewayAgentChannel` + `GatewayAgentInvocation`.
- [x] Improve gateway error model (structured `GatewayResponseError` + decoding errors include method).
- [x] Migrate mac call sites to typed helpers (leave only intentionally dynamic forwarding paths).
- [x] Convert remaining UI raw channel strings to `GatewayAgentChannel` (Cron editor).
- [x] Cleanup naming: rename remaining tests/docs that still reference “RPC/AgentRPC”.

### Notes

- Intentionally string-based:
  - `BridgeServer` dynamic request forwarding (method is data-driven).
  - `ControlChannel` request wrapper (generic escape hatch).

## Notes / Non-goals

- No functional behavior changes intended (beyond better errors and removing “magic strings”).
- Keep changes incremental: introduce typed APIs first, then migrate call sites, then remove old helpers.
