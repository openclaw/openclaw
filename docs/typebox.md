---
summary: "TypeBox schemas as the single source of truth for the gateway protocol"
read_when:
  - Updating protocol schemas or codegen
---
# TypeBox as Protocol Source of Truth

Last updated: 2025-12-09

We use TypeBox schemas in [`src/gateway/protocol/schema.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/gateway/protocol/schema.ts) as the single source of truth for the Gateway control plane (connect/req/res/event frames and payloads). All derived artifacts should be generated from these schemas, not edited by hand.

## Current pipeline

- **TypeBox → JSON Schema**: `pnpm protocol:gen` writes [`dist/protocol.schema.json`](https://github.com/clawdbot/clawdbot/blob/main/dist/protocol.schema.json) (draft-07) and runs AJV in the server tests.
- **TypeBox → Swift**: `pnpm protocol:gen:swift` generates [`apps/macos/Sources/ClawdbotProtocol/GatewayModels.swift`](https://github.com/clawdbot/clawdbot/blob/main/apps/macos/Sources/ClawdbotProtocol/GatewayModels.swift).

## Problem

- We want strong typing in Swift, including a sealed `GatewayFrame` enum with a discriminator and a forward-compatible `unknown` case.

## Preferred plan (next step)

- Add a small, custom Swift generator driven directly by the TypeBox schemas:
  - Emit a sealed `enum GatewayFrame: Codable { case req(RequestFrame), res(ResponseFrame), event(EventFrame) }`.
  - Emit strongly typed payload structs/enums (`ConnectParams`, `HelloOk`, `RequestFrame`, `ResponseFrame`, `EventFrame`, `PresenceEntry`, `Snapshot`, `StateVersion`, `ErrorShape`, `AgentEvent`, `TickEvent`, `ShutdownEvent`, `SendParams`, `AgentParams`, `ErrorCode`, `PROTOCOL_VERSION`).
  - Custom `init(from:)` / `encode(to:)` enforces the `type` discriminator and can include an `unknown` case for forward compatibility.
  - Wire a new script (e.g., `pnpm protocol:gen:swift`) into `protocol:check` so CI fails if the generated Swift is stale.

Why this path:
- Single source of truth stays TypeBox; no new IDL to maintain.
- Predictable, strongly typed Swift (no optional soup).
- Small deterministic codegen (~150–200 LOC script) we control.

## Alternative (if we want off-the-shelf codegen)

- Wrap the existing JSON Schema into an OpenAPI 3.1 doc (auto-generated) and use **swift-openapi-generator** or **openapi-generator swift5**. More moving parts, but also yields enums with discriminator support. Keep this as a fallback if we don’t want a custom emitter.

## Action items

- Implement `protocol:gen:swift` that reads the TypeBox schemas and emits the sealed Swift enum + payload structs.
- Update `protocol:check` to include the Swift generator output in the diff check.
- Remove quicktype output once the custom generator is in place (or keep it for docs only).
