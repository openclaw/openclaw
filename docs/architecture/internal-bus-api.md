---
summary: "M13 internal bus artifact API defined by schema contracts, example bundle, and proof coverage"
read_when:
  - Integrating with internal bus artifacts for registry and run envelopes
  - Verifying clean and known-bad payload behavior
  - Aligning implementation changes with M13 schema contract truth
title: "Internal Bus API"
---

# Internal bus API

Last updated: 2026-03-16

Mission M13 internal bus API is currently expressed as artifact contracts, not
as a separate public transport endpoint.

The contract truth is locked by:

- schemas
- example bundle payloads
- proof tests

## Contract surfaces

### Agent registry entry

- Schema: `schemas/agent-registry-entry.schema.json`
- Artifact kind: `internal.agent-registry-entry`
- Purpose: durable session registry state, identity, and route-law envelope

### Internal run envelope

- Schema: `schemas/internal-run.schema.json`
- Artifact kind: `internal.run`
- Purpose: run request, runtime context, and result status envelope

## Clean path artifacts

Clean payloads:

- `examples/internal-bus-bundle/clean/agent-registry-entry.json`
- `examples/internal-bus-bundle/clean/internal-run.json`

Clean-proof assertions:

- both payloads validate against their schemas

## Known invalid payloads

Known-bad payloads:

- `examples/internal-bus-bundle/known-bad-registry-state/agent-registry-entry.json`
- `examples/internal-bus-bundle/known-bad-failed-run/internal-run.json`

Deterministic reject conditions covered in proof:

- registry `state` value outside enum (`stuck`)
- failed run missing required `errorCode`

## Versioning and compatibility boundary

Both contracts are frozen at:

- `schemaVersion = 1`

Current M13 proof scope validates schema shape and deterministic reject behavior
for the included known-bad artifacts.

## Evidence and proof

Proof suite:

- `test/m13-bus-proof.test.ts`

Current proof assertions:

- clean registry and run payloads validate
- known-bad registry state fails enum validation
- known-bad failed run without `errorCode` fails required-field validation

## Relation to other M13 docs

- [Internal Agent Registry](/architecture/internal-agent-registry)
- [Run Orchestrator](/architecture/run-orchestrator)
- [Internal Session Model](/architecture/internal-session-model)
