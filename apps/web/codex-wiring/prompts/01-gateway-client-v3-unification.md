# Ticket 01 — Unify Gateway Client (Protocol v3 + Device Auth)

## Goal
Replace the split gateway client implementations in `apps/web` with a single protocol‑v3 compatible client that matches the legacy control UI handshake and event framing.

## Background
- Current state documented in `apps/web/codex-wiring/apps-web-rpc-map.md`.
- Legacy client in `ui/src/ui/gateway.ts` shows the required v3 handshake flow.
- Opus design emphasizes gateway as the source of truth (see `apps/web/ux-opus-design/00-CANONICAL-CONFIG-AND-TERMS.md`).

## Scope
- Implement protocol v3 handshake (connect.challenge → connect) with device identity support.
- Standardize frames to `{ type: "req" } / { type: "res" } / { type: "event" }`.
- Provide consistent connection status + reconnection behavior.
- Migrate all app usage to this single client.

## Requirements
1. **Handshake parity with legacy UI**
   - Support `connect.challenge` event (nonce), then `connect` RPC.
   - Use `minProtocol=3`, `maxProtocol=3` and `client.id = openclaw-control-ui` or equivalent.
   - Device identity signature when in secure context (HTTPS/localhost).
   - Support optional token/password auth.
2. **Event framing**
   - Emit events for `event` frames with `{ event, payload, seq }`.
   - Responses resolve pending requests by id.
3. **Connection lifecycle**
   - Auto reconnect with backoff.
   - Surface status callbacks for connected / disconnected / error.
4. **Single client**
   - All `apps/web` code should use this client.
   - Remove or adapt `apps/web/src/integrations/openclaw/*` as needed.

## Fixed Decisions (Do Not Re‑decide)
- **Client identity + mode:** use legacy values (`client.id = openclaw-control-ui`, `mode = webchat`).
- **Role + scopes:** `role = operator` with scopes `operator.admin`, `operator.approvals`, `operator.pairing`.
- **Handshake:** wait for `connect.challenge` (nonce) before sending `connect`.
- **Device auth:** use device identity + signature when in secure context; fall back to shared token/password when insecure.
- **Frame shapes:** only `{ type: "req" | "res" | "event" }` (no `rpc/response`).

## Required Payload Shape (from legacy)
- `connect` params must include:
  - `minProtocol: 3`, `maxProtocol: 3`
  - `client: { id, version, platform, mode, instanceId? }`
  - `role`, `scopes`, `caps: []`, `auth?`, `device?`, `userAgent`, `locale`
- On `hello-ok`, persist `auth.deviceToken` to local device store if present.

## Implementation Notes
- Use `ui/src/ui/gateway.ts` as the handshake reference.
- Ensure `PROTOCOL_VERSION` is 3 (gateway expects v3).
- Expose `request(method, params, timeoutMs?)` API that existing hooks can consume.

## Files to Touch (expected)
- `apps/web/src/lib/api/gateway-client.ts`
- `apps/web/src/lib/api/index.ts`
- `apps/web/src/hooks/useGatewayStreamHandler.ts`
- `apps/web/src/hooks/queries/useSessions.ts`
- `apps/web/src/integrations/openclaw/*` (remove or bridge)

## Acceptance Criteria
- `apps/web` connects successfully to a running gateway using v3 handshake.
- All gateway RPC calls (config, sessions, channels, etc.) work through the unified client.
- No remaining references to the old OpenClaw `rpc/response` framing.

## Out of Scope
- No UI redesign or new features; wiring only.

## Testing
- Manual: run gateway locally, verify connect + at least one RPC (e.g., `config.get`).
- Optional: add a small integration test for connect + request.
