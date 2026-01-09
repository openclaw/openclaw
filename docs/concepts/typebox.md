---
summary: "TypeBox schemas as the single source of truth for the gateway protocol"
read_when:
  - Updating protocol schemas or codegen
---
# TypeBox as protocol source of truth

Last updated: 2026-01-08

TypeBox schemas define the Gateway control plane (connect/req/res/event frames and
payloads). All generated artifacts must come from these schemas.

## Current pipeline

- `pnpm protocol:gen`
  - writes the JSON Schema output (draft‑07)
- `pnpm protocol:gen:swift`
  - generates Swift gateway models
- `pnpm protocol:check`
  - runs both generators and verifies the output is committed

## Swift codegen behavior

The Swift generator emits:

- `GatewayFrame` enum with `req`, `res`, `event`, and `unknown` cases
- Strongly typed payload structs/enums
- `ErrorCode` values and `GATEWAY_PROTOCOL_VERSION`

Unknown frame types are preserved as raw payloads for forward compatibility.

## When you change schemas

1) Update the TypeBox schemas.
2) Run `pnpm protocol:check`.
3) Commit the regenerated schema + Swift models.
