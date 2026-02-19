# Enterprise ConsentGate implementation plan for OpenClaw

Date: February 19, 2026
Status: Draft implementation plan for engineering execution

## 1) Executive summary

This document defines a complete implementation plan for an enterprise-grade
ConsentGate layer in OpenClaw.

Primary objective:

- Enforce explicit, auditable consent before high-risk tool execution across all
  relevant invoke paths, with deterministic policy decisions, replay resistance,
  fast revocation, and incident containment.

Secondary objective:

- Ship in stages that can be merged upstream as incremental PRs, with low-risk
  defaults and clear operator migration paths.

## 2) Scope and non-goals

In scope:

- Consent lifecycle: issue, consume, revoke, expire.
- Context binding: tool, session, route context, trust tier, and argument
  fingerprint.
- Atomic single-use consume semantics.
- Write-ahead log (WAL) for all decisions.
- Containment controls (anomaly score, quarantine, cascade revoke).
- Integration at gateway and node invoke choke points.
- Control UI and docs for operators.
- Optional out-of-process mode for high-assurance deployments.

Out of scope for initial enterprise release:

- Replacing existing OpenClaw auth models.
- Replacing existing exec approval UX.
- New identity provider implementation in core (can integrate with existing
  gateway auth and device pairing first).

## 3) Current codebase grounding

Current invoke and security surfaces:

- HTTP tool invoke: `src/gateway/tools-invoke-http.ts`
- Node command invoke: `src/gateway/server-methods/nodes.ts`
- Node host execution: `src/node-host/invoke.ts`
- Gateway HTTP high-risk deny defaults: `src/security/dangerous-tools.ts`
- Tool construction and tool list composition: `src/agents/openclaw-tools.ts`
- Tool policy pipeline layering: `src/agents/tool-policy-pipeline.ts`
- Gateway auth and trusted proxy and device paths: `src/gateway/auth.ts`

Current PoC UI hook:

- Consent simulation view: `ui/src/ui/views/consent-demo.ts`
- UI docs mention: `docs/web/control-ui.md`

## 4) Target architecture

### 4.1 Deployment modes

Mode A (default, first release):

- In-process ConsentGate module inside gateway process.
- Shared storage abstraction for token state and WAL.

Mode B (enterprise high assurance):

- Separate ConsentGate service with strict fail-closed behavior.
- Gateway and node-host invoke paths call ConsentGate over local socket or mTLS.

Recommendation:

- Build Mode A first for fast upstream integration and coverage.
- Keep storage and decision APIs transport-agnostic so Mode B is a drop-in
  deployment profile.

### 4.2 Core components

1. Consent Decision Engine

- Deterministic validation of issue and consume requests.
- Enforces policy, trust tier constraints, context hash checks, TTL checks.

2. Token State Store

- Atomic transition: `issued -> consumed | revoked | expired`.
- Backends:
  - v1: local durable store (sqlite or append+index model).
  - v2: external durable store for HA (for example DynamoDB or Postgres).

3. WAL subsystem

- Append-only structured event log.
- Correlation keys for forensics and SIEM export.

4. Containment subsystem

- Sliding-window op caps.
- Weighted anomaly score.
- Quarantine and cascading revoke.

5. Policy subsystem

- Enterprise profile for high-risk operations.
- Trust tier mapping by source/channel/session attributes.
- Multi-tenant policy namespace support.

6. Admin and observability surface

- Control UI tab moves from simulation to live state.
- Operator APIs for status, revoke, quarantine control, and audit export.

## 5) Security model and required properties

Required properties:

- P1 No execution without consent for gated operations.
- P2 Single-use token consume with atomic state transition.
- P3 Context binding and anti-laundering.
- P4 WAL completeness for all decisions.
- P5 Revocation immediacy.
- C3 Blast radius controls.
- C4 Anomaly containment.
- C5 Cascading revocation.
- P11 Cross-session isolation compatibility with existing session scope options.

Enterprise additions:

- Tenant isolation: policy and token namespaces per tenant.
- Dual authorization for critical operations (optional).
- Break-glass path with mandatory justification and audit marker.

## 6) Data contracts

### 6.1 Consent token (logical)

Required fields:

- `jti` unique id
- `status` one of `issued | consumed | revoked | expired`
- `tool`
- `trustTier`
- `sessionKey`
- `contextHash`
- `bundleHash` (optional by operation class)
- `issuedAt`, `expiresAt`
- `issuedBy` (principal id)
- `policyVersion`

### 6.2 WAL event

Required fields:

- `eventId`
- `ts`
- `type`
- `jti` nullable for no-token denials
- `tool`
- `sessionKey`
- `trustTier`
- `decision` allow or deny
- `reasonCode` deterministic machine code
- `correlationId` (run id or request id)
- `actor` (principal and channel metadata)
- `tenantId`

Event types:

- `CONSENT_ISSUED`
- `CONSENT_CONSUMED`
- `CONSENT_DENIED`
- `CONSENT_REVOKED`
- `CONSENT_EXPIRED`
- `TIER_VIOLATION`
- `CONTAINMENT_QUARANTINE`
- `CASCADE_REVOKE`
- `BUNDLE_MISMATCH`
- `IDEMPOTENT_HIT`

### 6.3 Consent request API

Internal API surface:

- `consent.issue(input) -> token`
- `consent.consume(input) -> decision`
- `consent.revoke(input) -> result`
- `consent.bulkRevoke(input) -> result`
- `consent.status(query) -> snapshot`

For Mode B (service):

- Keep equivalent RPC contracts over HTTP or unix socket.

## 7) Integration points and enforcement plan

### 7.1 Gateway HTTP invoke

File:

- `src/gateway/tools-invoke-http.ts`

Plan:

- Add consent check before `tool.execute(...)` for configured gated tool names.
- Keep existing deny list behavior in `DEFAULT_GATEWAY_HTTP_TOOL_DENY`.
- Fail closed when ConsentGate unavailable for gated tools.

Acceptance criteria:

- Any gated tool call without valid token returns deterministic deny code.
- Existing non-gated behavior unchanged.

### 7.2 Node invoke path

File:

- `src/gateway/server-methods/nodes.ts`

Plan:

- Add consent gating for high-risk `node.invoke` commands, especially
  `system.run`.
- Forward consent metadata in sanitized form through invoke params.
- Deny before forwarding when token missing or invalid.

Acceptance criteria:

- `node.invoke` for gated commands cannot bypass consent checks.
- Existing node command allowlist logic remains active and layered.

### 7.3 Node host execution path

File:

- `src/node-host/invoke.ts`

Plan:

- Require validated consent envelope for `system.run`.
- Enforce local replay and expiry checks at host boundary.
- Emit host-side audit event with request correlation.

Acceptance criteria:

- Even if upstream forwarding is flawed, host rejects missing or invalid consent
  for gated execution.

### 7.4 Tool policy integration

Files:

- `src/agents/openclaw-tools.ts`
- `src/agents/tool-policy-pipeline.ts`

Plan:

- Introduce consent-required tool classification and expose metadata to policy
  pipeline.
- Ensure final policy result cannot mark a denied high-risk tool as executable
  without consent.

Acceptance criteria:

- Policy and consent layers compose deterministically.

## 8) Enterprise policy model

### 8.1 Risk classes

Baseline high-risk operations:

- `exec`, `write`, `gateway`, `sessions_spawn`, `sessions_send`,
  `whatsapp_login`, `skills.install`, and node `system.run`.

Medium risk examples:

- `read`, `browser`, `cron`, `message` depending on tenant policy.

### 8.2 Trust tiers

Tier model:

- T0 owner paired
- T1 trusted peer
- T2 group mention
- T3 untrusted ingested content (email, scraped, external feeds)

Policy rules:

- Tier to tool matrix is explicit and deny-by-default.
- All token hashes include trust tier and session context.

### 8.3 Approvals and segregation of duties

Enterprise options:

- Optional second approver for critical operations.
- Optional explicit reconfirm for install/self-modifying operations.
- Configurable approval TTL and max operations per session window.

## 9) Storage and HA plan

Phase 1 storage:

- Local durable storage with atomic compare-and-set semantics.
- WAL rotation and compaction strategy.

Phase 2 storage:

- External HA backend with conditional writes and point-in-time recovery.
- Retention policy by tenant and compliance profile.

Targets:

- No split-brain consume results.
- RPO near zero for token state and WAL.
- RTO under agreed SLO for control plane outage.

## 10) Observability and audit

Metrics:

- issue/consume/revoke rates
- deny rates by reason code
- anomaly score and quarantine triggers
- storage latency and error rates
- unavailable fail-closed count

Logs and traces:

- Structured JSON logs for all decisions.
- Trace propagation from gateway request to host execution result.

Audit exports:

- SIEM-friendly event stream and periodic signed snapshots.
- Query endpoints for incident review by correlation id and session key.

## 11) Compliance and controls mapping

SOC 2 and ISO 27001 aligned control themes:

- Access control: explicit authorization before privileged operations.
- Change management: policy versioning and approval audit trails.
- Logging and monitoring: complete immutable decision events.
- Incident response: quarantine and emergency revoke runbooks.

Evidence artifacts:

- WAL schema and retention config
- policy snapshots
- test reports and attack scenario regression outputs
- operational runbooks

## 12) Delivery roadmap with phases

### Phase 0 Discovery and design (2 weeks)

Deliverables:

- Threat model for all invoke paths.
- Consent data model and reason code registry.
- Final architecture ADR for Mode A and Mode B.

Exit criteria:

- Approved design doc and API contracts.

### Phase 1 Core engine in gateway (4 weeks)

Deliverables:

- In-process consent engine and local state store.
- HTTP invoke integration in `tools-invoke-http.ts`.
- WAL writer and retention basics.
- Config keys for enablement and gated tool list.

Exit criteria:

- End-to-end gated HTTP invoke tests pass.
- No regression in existing non-gated paths.

### Phase 2 Node path hardening (4 weeks)

Deliverables:

- `node.invoke` consent enforcement in `nodes.ts`.
- host-side validation in `node-host/invoke.ts`.
- deterministic reason codes and structured denial payloads.

Exit criteria:

- Replay and bypass tests for node path pass.

### Phase 3 Containment and enterprise policy (3 weeks)

Deliverables:

- anomaly engine, quarantine, cascade revoke.
- trust tier policy mapping and runtime checks.
- admin controls for revoke and quarantine lift.

Exit criteria:

- Red-team scenario suite passes with expected decisions.

### Phase 4 Enterprise operations and HA (4 weeks)

Deliverables:

- external store adapter for HA profile.
- failover drills and backup restore validation.
- SIEM export path and compliance evidence pack.

Exit criteria:

- SLO and DR drills meet targets.

### Phase 5 Control UI and docs hardening (2 weeks)

Deliverables:

- Convert consent demo tab to live mode with feature flag.
- operator docs, runbooks, and rollout checklist.

Exit criteria:

- Operators can inspect and act on live consent events in UI.

### Phase 6 Upstream contribution sequence (ongoing)

Deliverables:

- PR series to openclaw/openclaw with isolated scopes.

Exit criteria:

- POC merged behind feature flags and docs published.

## 13) PR plan for upstream contribution

PR 1:

- Add shared consent types, reason codes, config schema, and no-op adapter.

PR 2:

- HTTP invoke consent enforcement with tests.

PR 3:

- Node invoke and node-host enforcement with tests.

PR 4:

- WAL and containment engine.

PR 5:

- Control UI live panel and docs updates.

PR 6:

- Optional service mode adapter and enterprise deployment docs.

Each PR requirements:

- Unit + integration tests.
- Clear migration notes.
- Feature flags default-off until validated.

## 14) Testing strategy

Test tiers:

- Unit: hash stability, TTL, consume transitions, reason code determinism.
- Integration: gateway invoke and node invoke end-to-end with WAL assertions.
- Concurrency: parallel consume races and idempotency behavior.
- Security regression: injection, tier escalation, replay, token laundering.
- Load: consent throughput and latency at expected peak.
- Chaos: storage latency spikes, partial outages, fail-closed verification.

Minimum acceptance gates:

- No high-risk tool execution without consent in test matrix.
- 100 percent deterministic deny reason for covered failure classes.
- Replay and double-spend blocks verified under concurrency.

## 15) Rollout and migration

Rollout sequence:

1. Dark launch with observe-only mode and WAL recording.
2. Enforce mode for a subset of high-risk tools.
3. Expand to full enterprise profile.
4. Enable Mode B service deployments for high-assurance tenants.

Operational safeguards:

- Feature flags per tool class.
- Emergency bypass only for break-glass admins, always audited.
- Automatic rollback to safe deny mode when policy state invalid.

## 16) Roles and staffing

Minimum team:

- 1 security lead
- 2 backend engineers
- 1 UI engineer
- 1 SRE or platform engineer
- 1 QA or test engineer

Optional:

- 1 formal methods engineer for property model and model checks.

## 17) Risks and mitigations

Risk: hidden bypass path

- Mitigation: enumerate invoke choke points and add deny-by-default at host.

Risk: false positive operational friction

- Mitigation: staged rollout, observe-only mode, reason-code analytics.

Risk: storage contention at scale

- Mitigation: conditional-write backend and sharding by tenant/session.

Risk: operator fatigue from approvals

- Mitigation: risk-based defaults, bounded TTL, policy tuning by role.

Risk: incomplete audit trail

- Mitigation: fail request when WAL write fails for gated decisions.

## 18) Definition of done

Enterprise ConsentGate is complete when:

- All gated operations across HTTP invoke and node invoke are enforced.
- Host execution path validates consent envelope.
- Atomic single-use and context binding properties hold under concurrency.
- WAL is complete, queryable, and exportable.
- Containment actions are tested and operationally documented.
- Control UI shows live consent state, not simulation-only state.
- Upstream PR series is merged or ready with maintainable feature flags.

## 19) Immediate next actions

Week 1:

1. Create architecture ADR and reason code registry.
2. Implement shared consent interfaces and config schema.
3. Add observe-only instrumentation in `tools-invoke-http.ts`.

Week 2:

1. Implement enforce mode for `exec`, `write`, `sessions_spawn`,
   `sessions_send`, and `gateway`.
2. Add regression tests for no-token, expired-token, and replay denial.
3. Draft operator runbook for deny reasons and break-glass usage.
