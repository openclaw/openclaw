---
summary: "M13 run orchestrator boundaries for ACP session init, status refresh, startup reconcile, and turn execution"
read_when:
  - Mapping manager lifecycle operations to M13 artifacts
  - Checking turn and status behavior against internal-run schema
  - Reviewing startup reconcile and per-session isolation boundaries
title: "Run Orchestrator"
---

# Run orchestrator

Last updated: 2026-03-16

Mission M13 uses `AcpSessionManager` as the current run orchestrator seam for
ACP-shaped sessions.

This document describes the manager operations that are already represented in
repo code and tests.

## Purpose

The orchestrator coordinates:

- session initialization and metadata persistence
- runtime status refresh and identity reconciliation
- startup identity reconcile for pending sessions
- turn execution state transitions

Primary implementation:

- `src/acp/control-plane/manager.core.ts`
- `src/acp/control-plane/manager.identity-reconcile.ts`
- `src/acp/control-plane/manager.types.ts`

## Lifecycle boundaries

### Initialize session

`initializeSession`:

- canonicalizes `sessionKey`
- validates and normalizes route-law bundle envelope when provided
- calls `runtime.ensureSession`
- writes ACP metadata for the session
- caches runtime handle state for later operations

### Get session status

`getSessionStatus`:

- ensures runtime handle exists
- reads runtime status via `runtime.getStatus` when available
- reconciles identity fields from status
- returns current metadata-backed status view

### Startup reconcile

`reconcilePendingSessionIdentities`:

- scans ACP sessions from discovery list
- skips malformed discovery rows
- deduplicates duplicate discovery rows by normalized `sessionKey`
- processes pending identities only
- tolerates per-entry status read failures with `failOnStatusError: false`
- reports `checked`, `resolved`, and `failed` counts

### Run turn

`runTurn`:

- sets session state to `running` at turn start
- streams runtime events
- sets session state to `idle` on success
- sets session state to `error` with `lastError` on failure
- reconciles identity after turn for persistent sessions
- closes oneshot sessions after completion

## Internal run artifact contract

The M13 run envelope is defined by:

- `schemas/internal-run.schema.json`

Required top-level fields:

- `kind`, `schemaVersion`, `runId`, `sessionKey`, `request`, `runtime`, `result`

Status rules in schema:

- `result.status = "failed"` requires `errorCode` and `errorMessage`
- `result.status = "completed"` requires `completedAt`

## Clean and invalid examples

Clean example:

- `examples/internal-bus-bundle/clean/internal-run.json`

Known invalid example:

- `examples/internal-bus-bundle/known-bad-failed-run/internal-run.json`
- rejected because `result.status = "failed"` is missing `errorCode`

Proof:

- `test/m13-bus-proof.test.ts`

## Related artifacts

- [Internal Agent Registry](/architecture/internal-agent-registry)
- [Internal Session Model](/architecture/internal-session-model)
- [Internal Bus API](/architecture/internal-bus-api)
