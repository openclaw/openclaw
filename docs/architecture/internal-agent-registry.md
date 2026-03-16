---
summary: "M13 internal agent registry contract for ACP-shaped session state and identity envelopes"
read_when:
  - Reviewing M13 registry entry fields and lifecycle boundaries
  - Validating startup reconcile behavior against registry artifacts
  - Aligning docs with internal bus schema and proof bundle
title: "Internal Agent Registry"
---

# Internal agent registry

Last updated: 2026-03-16

Mission M13 defines an internal registry entry that captures ACP session state,
identity, and route-law context.

The canonical contract is `schemas/agent-registry-entry.schema.json`.

## Purpose

The internal agent registry entry gives one stable shape for:

- session identity and runtime naming
- session lifecycle state (`idle`, `running`, `error`)
- route-law envelope carry-over needed by ACP manager flows
- runtime option snapshots used by turn execution and status reads

## Contract boundary

Required top-level fields in schema version 1:

- `kind = "internal.agent-registry-entry"`
- `schemaVersion = 1`
- `sessionKey`
- `agentId`
- `backend`
- `runtimeSessionName`
- `mode` (`persistent` or `oneshot`)
- `state` (`idle`, `running`, `error`)
- `lastActivityAt`

Optional envelopes:

- `identity` with:
  - `state` (`pending` or `resolved`)
  - `source` (`ensure`, `status`, `event`)
  - `lastUpdatedAt`
  - optional ACP session ids
- `routeLaw` with decision id, classification, verdict, reject reasons, and
  namespaces
- `runtimeOptions` with runtime mode, model, cwd, permission profile, timeout,
  and backend extras
- `lastError` when state is `error`

## Clean path example

Clean artifact:

- `examples/internal-bus-bundle/clean/agent-registry-entry.json`

The clean example shows:

- resolved identity from status
- cousin route-law envelope with empty reject reasons
- runtime options populated for plan mode execution

## Known invalid conditions

Deterministic invalid example:

- `examples/internal-bus-bundle/known-bad-registry-state/agent-registry-entry.json`

The M13 proof verifies that `state = "stuck"` is rejected by schema enum
validation.

## Relation to manager behavior

Current ACP manager behavior that maps to this contract:

- `initializeSession` writes fresh ACP metadata with mode, backend, runtime
  session name, and pending identity.
- `runTurn` transitions state through `running` and then `idle` or `error`.
- `getSessionStatus` and startup reconcile update identity from runtime status.
- startup reconcile deduplicates duplicate discovery rows by normalized
  `sessionKey` before entry processing.

These behaviors are validated in `src/acp/control-plane/manager.test.ts`.

## Related artifacts

- Schema: `schemas/agent-registry-entry.schema.json`
- Proof: `test/m13-bus-proof.test.ts`
- Bundle: `examples/internal-bus-bundle/`
- Related docs:
  - [Run Orchestrator](/architecture/run-orchestrator)
  - [Internal Session Model](/architecture/internal-session-model)
  - [Internal Bus API](/architecture/internal-bus-api)
