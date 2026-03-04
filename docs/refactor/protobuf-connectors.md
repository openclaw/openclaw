---
summary: "Generate multi-language connectors from OpenClaw protocol protobuf mirror"
read_when:
  - You want SDK/client generation for languages beyond TS/Swift
  - You need the current connector generation matrix and tool prerequisites
title: "Protobuf Connectors"
---

# Protobuf connectors

OpenClaw can generate a protobuf mirror (`dist/protocol.proto`) from current protocol schemas, then generate client/model connectors in multiple languages.

## Commands

```bash
pnpm protocol:gen
pnpm protocol:gen:proto
pnpm protocol:gen:connectors
```

Output report:

- `dist/connectors/README.md`

## Current generation targets

- TypeScript (via `ts-proto`)
- Python
- Java
- C#
- PHP
- Ruby
- Go (when `protoc-gen-go` is installed)

## Why this improves current system

- New language connectors can be generated from one contract.
- Existing JSON/WebSocket workflows continue to work unchanged.
- Migration to efficient protobuf transport can happen gradually via negotiation.

## Compatibility constraints

- Keep current method/event semantics unchanged.
- Keep JSON transport as default until protobuf transport rollout is complete.
- Add parity tests for JSON vs protobuf behavior before enabling protobuf by default.
