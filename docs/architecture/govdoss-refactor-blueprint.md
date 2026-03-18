# GovDOSS OODA Refactor Blueprint

## Purpose

Refactor GODSClaw toward a design that is:

- **Simple** enough to reason about and operate
- **Secure** by default and policy-first
- **Sustainable** through modular ownership and repeatable controls
- **Scalable** across channels, workspaces, tools, devices, and agents

This blueprint aligns the system with GovDOSS, KIS4, and SOA4 principles.

## Governing principles

### GovDOSS pillars

- **Governance:** every decision is policy-evaluable and auditable
- **Defensive:** inbound content, tool execution, and automation are treated as hostile until proven otherwise
- **Offensive:** the system should accelerate mission outcomes through specialized agents and controlled autonomy
- **Sustainment:** all flows must be observable, testable, and maintainable
- **Systems Integration:** components integrate through typed contracts and gateways, not ad hoc couplings

### KIS4

- **Simple:** keep decision loops explicit and typed
- **Secure:** default deny for privileged actions
- **Sustainable:** minimize hidden state and duplicate logic
- **Scalable:** isolate policy, planning, execution, and audit concerns

### SOA4

Every significant action should record:

- **Subject**: which session, user, or agent initiated the behavior
- **Object**: which tool, file, channel, URL, device, or resource was targeted
- **Authentication**: what identity or credential context was in effect
- **Authorization**: why access was permitted or denied
- **Approval**: whether a human or policy gate approved the action
- **Action**: what was attempted and what occurred

## Required system shape

All autonomous or semi-autonomous flows should be decomposed into the same pipeline:

1. **Observe**
2. **Orient**
3. **Decide**
4. **Act**
5. **Assess**

This is the system-wide OODA loop.

## Mandatory architectural boundaries

### 1. Observation layer

Only collects facts, metadata, and environmental state.

Examples:

- inbound message payloads
- browser/page observations
- desktop/operator observations
- node/device state
- workspace config
- model outputs

Observation code should not directly execute privileged actions.

### 2. Orientation layer

Transforms raw observations into normalized context.

Examples:

- policy context resolution
- risk scoring
- session and workspace lookup
- memory retrieval and relevance ranking
- threat and safety classification

### 3. Decision layer

Produces explicit plans.

Requirements:

- typed decision outputs
- rationale and confidence
- risk classification
- policy dependency visibility
- deterministic serialization for replay and review

### 4. Action layer

Executes only approved actions through adapters.

Requirements:

- no implicit privilege escalation
- uniform adapter contract for browser, channel, node, and host actions
- dry-run support when feasible
- full result capture

### 5. Assessment layer

Verifies success, logs outcomes, and chooses retry, rollback, or escalation.

## Refactor priorities

### Priority A: centralize control logic

Create shared modules for:

- decision envelopes
- policy gates
- approval handling
- audit events
- risk scoring
- outcome assessment

### Priority B: move from implicit to explicit autonomy

No component should jump directly from model output to high-impact execution.

Every action path should pass through:

- policy evaluation
- approval evaluation
- audit event emission
- verification or rollback handling

### Priority C: isolate privileged adapters

Privileged functionality should be thin adapters behind policy gates.

Examples:

- browser actions
- command execution
- file mutation
- node or device invocation
- channel posting in sensitive contexts

### Priority D: standardize auditability

All significant actions should emit structured events compatible with SOA4.

## Implementation strategy

### Phase 1: foundations

- add GovDOSS core types and OODA contracts
- add decision envelope and audit schema
- add reusable policy and approval engine
- add risk tiers and trust zones

### Phase 2: integration

- wire operator-node through OODA contracts
- wire browser tooling through action adapters
- wire channel and node actions through policy guards
- add workspace-level governance config

### Phase 3: enforcement

- require decision envelopes for high-risk actions
- require approval tokens for approval-gated actions
- require assessment events for all privileged actions
- add tests and lint checks for bypass patterns

## Non-goals for this first pass

- full replacement of existing runtime behavior in one change
- broad invasive edits without adapter boundaries
- hidden heuristics that bypass policy or approval models

## Deliverables in this branch

- GovDOSS core extension scaffold
- OODA contracts
- policy, approval, and audit primitives
- workspace governance config example
- migration blueprint for future enforcement
