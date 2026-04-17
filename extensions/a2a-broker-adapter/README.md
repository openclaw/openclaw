# A2A Broker Adapter

This package is the owning OpenClaw integration surface for the standalone `a2a-broker` system.

## Target role

This plugin should own:

- broker client configuration
- OpenClaw-to-broker task transport
- task reconcile / cancel mapping for broker-backed delegated tasks
- A2A-specific status contribution for OpenClaw surfaces

OpenClaw core should keep only generic delegated-task seams.

## Current state

This package now owns the plugin-facing A2A gateway surface and explicit activation migration:

- plugin-local `a2a.task.request/update/cancel/status` gateway handlers
- plugin-local AJV/TypeBox request validation for those methods
- a config migration that backfills explicit activation when legacy broker config already exists

A substantial amount of broker transport and task-runtime logic still lives in core under:

- `src/agents/a2a/*`
- `src/agents/tools/sessions-send-tool.a2a.ts`
- `src/agents/tools/sessions-send-openclaw-adapter.ts`
- `src/agents/tools/sessions-send-standalone-broker-adapter.ts`

That is still transitional, not the intended final ownership.

## Explicit activation policy

This plugin stays off until broker routing is selected explicitly and a broker base URL is present.
Supported activation paths:

- `plugins.entries["a2a-broker-adapter"].enabled: true`
- `plugins.allow: ["a2a-broker-adapter"]`

Additional rules:

- `plugins.entries["a2a-broker-adapter"].enabled: false` keeps it off
- a non-empty `plugins.allow` that omits `a2a-broker-adapter` keeps it off
- `plugins.entries["a2a-broker-adapter"].config.baseUrl` is still required for routing

The migration hook appends `a2a-broker-adapter` to `plugins.allow` when a restrictive allowlist already exists, so older broker configs do not silently break during the ownership split.

## Migration direction

1. finish moving broker client + adapter transport logic into this package
2. expose plugin-owned runtime helpers from this package's public surface
3. replace remaining core A2A imports with a generic delegation transport seam
4. remove duplicated core A2A gateway and status wiring once the plugin path is complete

See also:

- `notes/a2a-plugin-standalone-broker-redesign.md`
