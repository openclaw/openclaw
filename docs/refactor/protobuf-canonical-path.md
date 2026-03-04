---
summary: "Plan to move from JSON-schema-first protocol mirror to protobuf-canonical connectors without breaking current workflows"
read_when:
  - You want multi-language connectors (TS/Rust/Go/...) from a single canonical interface
  - You need a no-break migration path from existing Gateway JSON/WebSocket protocol
title: "Protobuf Canonical Path"
---

# Protobuf canonical path (no-break migration)

OpenClaw currently uses TypeBox/JSON Schema as protocol source of truth.
This document defines a compatible migration path to protobuf as canonical interface **without breaking existing workflows**.

## Current state

- Source of truth: `src/gateway/protocol/schema/*` (TypeBox)
- Generated JSON Schema: `dist/protocol.schema.json`
- Generated Swift models: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## New bridge artifact

- Generated proto mirror: `dist/protocol.proto`
- Generator: `scripts/protocol-gen-proto.ts`
- Command: `pnpm protocol:gen:proto`

This proto file is a compatibility mirror of the current protocol contract.

## Migration phases

### Phase 0 — Mirror only (current)

- Keep wire protocol unchanged (JSON over WebSocket)
- Generate `protocol.proto` from existing schema
- Start connector generation experiments from proto

### Phase 1 — Typed connectors

- Generate language SDKs from proto for TS/Rust/Go/Python
- Add conformance tests against live gateway:
  - handshake
  - request/response framing
  - event decoding

### Phase 2 — Canonicalization

- Freeze proto package versioning strategy
- Add strict change policy (backward compatibility gates)
- Make proto the canonical interface spec while preserving JSON wire compatibility layer

### Phase 3 — Optional transport upgrades

- Optional protobuf transport can be added later
- JSON transport remains supported for compatibility

## Compatibility constraints

- No breaking change to existing method names/events during migration
- Existing JSON clients remain fully functional
- Proto generation failures must fail CI in protocol checks once adopted
- Transport migration must be negotiated and backwards-compatible:
  - client may advertise `transports` in `connect` params
  - server returns selected `transport` in `hello-ok`
  - current default remains `json-ws`

## Next steps

1. Add proto conformance fixtures for frame encode/decode.
2. Add initial generated TS/Rust connector prototypes using `dist/protocol.proto`.
3. Extend `protocol:check` to include proto generation and drift detection.
