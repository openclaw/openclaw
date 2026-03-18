# Operator Node Foundation RFC

## Goal

Add a governed computer-use capability to GODSClaw so the assistant can:

- observe desktop and browser state
- propose or execute bounded actions
- verify outcomes and recover from drift
- preserve a full approval and audit trail

This keeps the current Gateway-first model intact while introducing a reusable operator subsystem.

## Design principles

- **Gateway-first:** the Gateway remains the control plane for operator sessions.
- **Policy-first:** all actions flow through explicit policy and approval gates.
- **Workspace isolation:** operator state is scoped per workspace and session.
- **Multimodal by default:** screenshots, OCR, UI structure, and tool feedback are all first-class inputs.
- **Reversible where possible:** actions should be simulated, previewed, or checkpointed before execution.

## Target capability set

### Phase 1

- screenshot ingestion
- OCR/UI element extraction
- action proposals
- risk scoring
- approval-required execution
- outcome verification
- structured audit logs

### Phase 2

- recorded task replay
- layout drift recovery
- browser-plus-desktop hybrid execution
- reusable operator macros
- per-app allow and deny policies

### Phase 3

- delegated planner / operator / reviewer agents
- adaptive execution under bounded autonomy
- fleet and multi-device operator routing
- compliance-ready attestation exports

## Core architecture

### 1. Perception Engine

Normalizes desktop/browser observations into an `OperatorObservation`.

Inputs:

- screenshot
- window title and app identity
- OCR text blocks
- DOM or accessibility tree when available
- cursor position and viewport metadata

Outputs:

- candidate targets
- confidence scores
- observation hash for replay and audit

### 2. Planner

Transforms a user goal plus observation into a structured `OperatorPlan`.

Plan steps should be explicit and testable:

1. observe
2. decide
3. act
4. verify
5. recover or escalate

### 3. Policy Engine

Applies workspace-specific controls before any action is executed.

Policy checks:

- mode: read-only, suggest-only, approval-required, bounded-autonomy
- allowed apps / URLs / file paths / commands
- blocked secrets and regulated destinations
- max consecutive actions
- confidence and risk thresholds

### 4. Executor

Runs approved actions through typed adapters.

Initial adapter families:

- browser adapter
- desktop input adapter
- node/device adapter

### 5. Verifier

Confirms whether the intended effect occurred and determines whether to continue, retry, or hand off.

### 6. Audit Layer

Writes structured logs for every plan, approval, execution step, and result.

## Safety modes

### Read-only

Observe and summarize only. No actions.

### Suggest-only

Produce candidate actions with rationale and risk score.

### Approval-required

Every state-changing action requires human approval.

### Bounded autonomy

Allow execution within pre-approved policy envelopes.

## Proposed repo integration points

- `extensions/operator-node/` for the initial extension boundary
- browser integration through existing browser tooling
- device actions routed through existing node concepts
- workspace policy loaded from workspace-level config
- audit events emitted through the Gateway event model

## Initial implementation backlog

1. define operator contracts and policy types
2. add a minimal operator extension scaffold
3. implement screenshot-to-observation normalization
4. add action proposal and policy evaluation pipeline
5. add verification hooks and audit events
6. add tests for policy and risk gating

## Success criteria

- operator actions are always attributable to a session and workspace
- the system can run in read-only and approval-required modes without unsafe fallthrough
- operator plans are serializable, replayable, and reviewable
- browser and desktop actions share one policy and audit model
