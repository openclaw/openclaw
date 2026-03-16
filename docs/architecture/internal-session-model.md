---
summary: "M13 internal session model for ACP metadata, identity state, route-law envelope, and runtime options"
read_when:
  - Reviewing ACP metadata fields and allowed state transitions
  - Mapping SessionAcpMeta to registry and run artifacts
  - Checking identity and lastError behavior in manager lifecycle paths
title: "Internal Session Model"
---

# Internal session model

Last updated: 2026-03-16

Mission M13 internal session state is represented by `SessionAcpMeta` and
related types in `src/config/sessions/types.ts`.

## Purpose

The internal session model captures durable ACP metadata per session key:

- runtime identity fields
- route-law envelope carry-over
- current lifecycle state
- runtime option state used by control operations

## Core type boundary

`SessionAcpMeta` fields:

- required:
  - `backend`
  - `agent`
  - `runtimeSessionName`
  - `mode` (`persistent` or `oneshot`)
  - `state` (`idle`, `running`, `error`)
  - `lastActivityAt`
- optional:
  - `identity`
  - `routeLaw`
  - `runtimeOptions`
  - `cwd`
  - `lastError`

`SessionAcpIdentity` fields:

- required:
  - `state` (`pending` or `resolved`)
  - `source` (`ensure`, `status`, `event`)
  - `lastUpdatedAt`
- optional:
  - `acpxRecordId`
  - `acpxSessionId`
  - `agentSessionId`

`SessionAcpRouteLawEnvelope` fields include:

- `decisionId`
- `classification`
- `verdict`
- `rejectReasons`
- trace and receipt namespaces
- `correlationId`
- optional ticket id and digest

## Manager lifecycle alignment

Observed manager behavior:

- session init writes metadata with `state = idle` and pending identity derived
  from ensure result
- turn start sets `state = running` and clears previous `lastError`
- turn success sets `state = idle` and clears `lastError`
- turn failure sets `state = error` with `lastError`
- status and startup reconcile paths merge status-derived identity fields
- if identity write persistence degrades during reconcile, manager keeps prior
  metadata instead of reporting false resolved state

## Clean path and invalid boundaries

Session-model fields are represented in:

- `examples/internal-bus-bundle/clean/agent-registry-entry.json`
- `examples/internal-bus-bundle/clean/internal-run.json`

Invalid boundaries currently covered by schema and proof:

- registry `state` must be `idle`, `running`, or `error`
- failed run result must include full error envelope (`errorCode` and
  `errorMessage`)

## Relation to M13 artifacts

- registry contract: `schemas/agent-registry-entry.schema.json`
- run contract: `schemas/internal-run.schema.json`
- proof suite: `test/m13-bus-proof.test.ts`
- manager behavior tests: `src/acp/control-plane/manager.test.ts`

## Related docs

- [Internal Agent Registry](/architecture/internal-agent-registry)
- [Run Orchestrator](/architecture/run-orchestrator)
- [Internal Bus API](/architecture/internal-bus-api)
