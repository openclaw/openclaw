---
summary: "Final review-first GitHub issue bodies for gateway abuse hardening (A-E) with overlap boundaries"
read_when:
  - Preparing security hardening issues for gateway abuse controls
  - Verifying non-duplication with active PRs before filing
owner: "openclaw"
status: "review-ready"
last_updated: "2026-02-25"
title: "Gateway Security Hardening Issue Pack"
---

# Gateway Security Hardening Issue Pack

Review-first final draft set. Do not post yet.

Source of truth note:
After issues are filed and accepted, the canonical requirements move to those GitHub issues and linked implementation PRs.
This experiments plan is a pre-filing snapshot and should not be treated as long-term normative security guidance.

## Active Overlap Baseline (Verified 2026-02-25)

- [#15035](https://github.com/openclaw/openclaw/pull/15035) merged: gateway auth brute-force + auth rate limiting.
- [#19515](https://github.com/openclaw/openclaw/pull/19515) open: per-connection WebSocket rate limiting.
- [#25751](https://github.com/openclaw/openclaw/pull/25751) open: per-sender message rate limiting + cost budget tracking.
- [#26050](https://github.com/openclaw/openclaw/pull/26050) open: Feishu webhook state bounding.
- [#26067](https://github.com/openclaw/openclaw/pull/26067) open: Feishu off-path webhook budget isolation.

Cross-ticket implementation conventions (explicit):

- Use a typed, schema-backed config namespace under `gateway.abuse.*` (with updates in `types.gateway.ts`, `zod-schema.ts`, `schema.help.ts`, and `schema.labels.ts`).
- Keep throttle contracts consistent:
  - RPC: `UNAVAILABLE` + `retryable=true` + `retryAfterMs`.
  - HTTP: `429` + `Retry-After`.
- Name exact gateway surfaces in scope: `chat.send`, `send`, `node.invoke`, and mapped HTTP endpoints (`/v1/chat/completions`, `/v1/responses`) when a ticket claims parity.
- Store incident/correlation/audit evidence durably (not only ephemeral in-memory event queues).
- Use stable check IDs (for example `gateway.abuse.*` for runtime checks/events; `security.exposure.*` for posture findings when applicable).

Shared explicit non-goals for every ticket:

- Not replacing existing auth/websocket/webhook/per-sender throttles.
- Not re-implementing open PRs #25751, #19515, #15035, #26067, #26050.

## Ticket A (Final)

**Title**

`security(gateway): semantic capability-extraction anomaly detection across chat.send/send/node.invoke and tool events`

**GitHub-ready issue body**

**Summary**

Add semantic anomaly detection for capability-extraction abuse patterns across `chat.send`, `send`, `node.invoke`, and tool-event streams, with staged enforcement and operator-visible evidence.

**Problem**

Current controls are primarily volumetric and ingress-specific. Authenticated, slow-drip extraction campaigns can evade per-connection/per-sender thresholds while repeating semantically similar prompt and tool-use patterns.

**Proposal**

1. Add a normalized feature pipeline for prompts/tool sequences (template similarity, sequence reuse, extraction signatures).
2. Score traffic by actor/device/IP/session tuple (plus account/channel when available).
3. Apply staged actions (`observe -> throttle -> temporary block`) with safe defaults.
4. Emit structured abuse events with stable check IDs and reason codes.
5. Keep config under `gateway.abuse.anomaly.*` with schema/help/labels coverage.

**Scope**

- Semantic detection and scoring for `chat.send`, `send`, `node.invoke`, and tool-event-linked chat runs.
- Staged policy hooks and security event emission.
- Operator queryability for actor tuple + method + fingerprint reasons.

**Acceptance Criteria**

1. Detector evaluates the in-scope methods and tool-event-linked runs.
2. Throttle responses follow gateway contracts (`UNAVAILABLE` + `retryAfterMs` for RPC; `429` + `Retry-After` for mapped HTTP).
3. Events include actor/device/IP/session, method, fingerprint/reason, threshold, and action.
4. Tests cover benign traffic, repeated-template extraction, and false-positive guardrails.
5. Rollout supports observe-only mode by default.

**Non-goals**

- Not replacing existing auth/websocket/webhook/per-sender throttles.
- Not re-implementing open PRs #25751, #19515, #15035, #26067, #26050.

**Overlap boundaries (active work)**

- Complements #25751 (per-sender rate/cost) with semantic pattern detection; does not replace sender quotas.
- Complements #19515 (per-connection WS limits); does not alter WS message flood controls.
- Independent of #26050/#26067 (Feishu webhook ingress hardening).
- Leaves #15035 auth brute-force/rate-limit behavior intact.

**Why this is net-new**

No active control performs semantic, cross-method capability-extraction detection with staged response and structured reason codes.

## Ticket B (Final)

**Title**

`security(gateway): unified post-auth abuse quotas across chat.send/send/node.invoke with consistent RPC+HTTP retry semantics`

**GitHub-ready issue body**

**Summary**

Add one post-auth quota engine for `chat.send`, `send`, and `node.invoke`, with consistent enforcement semantics across RPC and mapped HTTP endpoints.

**Problem**

Quota behavior is fragmented by surface. Without a unified post-auth budget model, actors can shift between methods/endpoints and get inconsistent throttling and visibility.

**Proposal**

1. Introduce `gateway.abuse.quota.*` with burst + sustained budgets and per-method defaults.
2. Key budgets by actor/device/IP/session (+channel/account when present).
3. Enforce centrally for gateway RPC methods and mapped HTTP entry points (`/v1/chat/completions`, `/v1/responses`) to avoid bypass.
4. Standardize throttle outputs (RPC `UNAVAILABLE` + `retryable=true` + `retryAfterMs`; HTTP `429` + `Retry-After`).
5. Emit quota audit signals for triage and incident correlation.

**Scope**

- Shared quota definitions and enforcement path for `chat.send`, `send`, `node.invoke`.
- HTTP parity for mapped endpoints that route to those execution paths.
- Operator-visible quota events and diagnostics fields.

**Acceptance Criteria**

1. Limits apply consistently across all in-scope methods/endpoints.
2. Retry semantics match existing gateway conventions on RPC and HTTP.
3. Logs/events include quota key dimensions and triggered threshold.
4. Tests cover partitioning (actor/device/IP/session), reset behavior, and endpoint parity.
5. Observe-only and enforce modes are configurable.

**Non-goals**

- Not replacing existing auth/websocket/webhook/per-sender throttles.
- Not re-implementing open PRs #25751, #19515, #15035, #26067, #26050.

**Overlap boundaries (active work)**

- Does not replace #25751 per-sender rate/cost controls; this ticket targets cross-method post-auth quota unification and contract consistency.
- Does not touch #19515 WS per-connection limits.
- Does not touch Feishu webhook controls in #26050/#26067.
- Does not modify #15035 auth-layer throttles.

**Why this is net-new**

No current implementation provides one quota contract spanning `chat.send`, `send`, and `node.invoke` with explicit RPC/HTTP parity and unified operator telemetry.

## Ticket C (Final)

**Title**

`security(gateway): cross-account and proxy-fanout campaign correlation for coordinated abuse clustering`

**GitHub-ready issue body**

**Summary**

Add a cross-account correlation layer that detects coordinated abuse campaigns spanning many accounts/devices/IPs/proxies, especially where single-identity controls are intentionally evaded.

**Problem**

Per-actor controls do not catch coordinated campaigns that rotate accounts/devices/proxy egress while preserving the same extraction behavior.

**Proposal**

1. Ingest normalized events from `chat.send`, `send`, `node.invoke`, tool events, and quota/anomaly outcomes.
2. Build rolling correlation clusters keyed by shared infra and behavior signals.
3. Emit deterministic cluster IDs, risk scores, and reason codes (fan-out, synchronized templates, timing coordination).
4. Persist correlation state/evidence durably for cross-session investigations.
5. Add query surfaces for cluster timeline and blast-radius views.
6. Configure via `gateway.abuse.correlation.*` with explicit window and decay settings.

**Scope**

- Cross-account/proxy clustering and scoring.
- Durable correlation evidence store.
- Operator queryability by actor, IP, account, or cluster ID.

**Acceptance Criteria**

1. Correlation ingests all in-scope abuse signals and emits stable cluster IDs.
2. Findings include score/confidence, reason codes, and linked identities.
3. Tests cover account rotation, proxy fan-out, and synchronized template reuse.
4. Cluster records survive process restarts and are queryable.
5. Default rollout is observe-only with bounded retention.

**Non-goals**

- Not replacing existing auth/websocket/webhook/per-sender throttles.
- Not re-implementing open PRs #25751, #19515, #15035, #26067, #26050.

**Overlap boundaries (active work)**

- Uses outputs from A/B and existing controls; does not duplicate their enforcement logic.
- Complements #25751 by catching distributed evasion across many identities.
- Separate from #19515 connection-local WS flooding controls.
- Separate from Feishu webhook ingress hardening (#26050/#26067).

**Why this is net-new**

No active work provides durable, campaign-level cross-account/proxy clustering with risk scoring across gateway method traffic.

## Ticket D (Final)

**Title**

`security(gateway): incident-response lifecycle with auto-containment and operator playbook for abuse events`

**GitHub-ready issue body**

**Summary**

Create a formal abuse incident workflow that turns detections into consistent containment actions, operator triage, and documented recovery steps.

**Problem**

Detection alone leaves high-severity response manual and inconsistent. The system lacks a unified incident state model, automatic containment hooks, and an operator-ready playbook.

**Proposal**

1. Add incident lifecycle states (`open -> investigating -> contained -> resolved`).
2. Trigger incident records from high-severity abuse events.
3. Add configurable auto-containment actions (temporary actor/device/session/cluster quarantine, method cooldown).
4. Provide operator actions (`acknowledge`, `escalate`, `release`, `annotate`) with full audit trail.
5. Persist incident timelines/evidence durably and expose summary + deep diagnostics.
6. Define `gateway.abuse.incident.*` config and publish an on-call playbook.

**Scope**

- Incident state machine + persistence.
- Auto-containment policy hooks.
- Operator controls and documented recovery workflow.

**Acceptance Criteria**

1. Incident records are created automatically from qualifying events.
2. Auto-containment is time-bounded, reversible, and policy-configurable.
3. Operator transitions are audited with actor/time/rationale.
4. Incident timelines link event IDs, cluster IDs, thresholds, and containment actions.
5. Docs include triage, rollback, and false-positive handling procedures.

**Non-goals**

- Not replacing existing auth/websocket/webhook/per-sender throttles.
- Not re-implementing open PRs #25751, #19515, #15035, #26067, #26050.

**Overlap boundaries (active work)**

- Consumes detector outputs from A/B/C and existing controls; does not redefine their quota/detection math.
- Does not alter #25751 sender throttles/cost budgets.
- Does not alter #19515 WS per-connection limits.
- Does not alter #15035 auth brute-force controls.
- Does not alter Feishu webhook protections in #26050/#26067.

**Why this is net-new**

There is no unified, durable incident lifecycle with built-in containment and operator workflow tied to gateway abuse events.

## Ticket E (Final)

**Title**

`security(audit): gateway abuse audit ledger for request/anomaly/quota/correlation/incident events`

**GitHub-ready issue body**

**Summary**

Add a unified, queryable abuse audit ledger for gateway `request`, `anomaly`, `quota`, `correlation`, `incident`, and `containment` events.

**Problem**

Abuse decisions are currently split across handler logs and in-memory state, making timeline reconstruction and policy debugging harder during incidents.

**Proposal**

1. Define a canonical abuse-event ledger schema (actor/device/IP/session/channel/account, allow/deny/action, checkId, severity, score, cluster/incident links).
2. Record ledger rows at central abuse decision points for RPC + HTTP paths.
3. Persist ledger records durably with retention/rotation controls.
4. Expose query/report filters for actor, channel, method, incident, and checkId.
5. Configure under `gateway.abuse.auditLedger.*` and document schema/redaction rules.

**Scope**

- Canonical schema + durable event pipeline for abuse decision events.
- RPC + mapped HTTP coverage for abuse decision logging.
- Query/report surfaces for incident evidence timelines.

**Acceptance Criteria**

1. Ledger records are emitted for request/anomaly/quota/correlation/incident/containment decision points.
2. Records include tuple correlation fields and check identifiers needed for investigations.
3. Records persist across restart with retention and max-record enforcement.
4. Operators can filter/report by actor, channel, method, and incident link.
5. Docs define retention defaults, redaction behavior, and export semantics.

**Non-goals**

- Not replacing existing auth/websocket/webhook/per-sender throttles.
- Not re-implementing open PRs #25751, #19515, #15035, #26067, #26050.

**Overlap boundaries (active work)**

- Complements A/B/C/D by providing durable decision evidence; does not change their enforcement logic.
- Does not replace #25751 sender-rate/cost decisions.
- Does not modify #19515 WS connection throttles.
- Does not modify Feishu webhook protections in #26050/#26067.
- Does not modify #15035 auth hardening paths.

**Why this is net-new**

No active implementation provides one durable abuse-decision ledger spanning request/anomaly/quota/correlation/incident events with incident-linkable query semantics.

### Follow-up PR (separate)

Tool-event + extension-channel audit coverage is intentionally split into a separate follow-up PR:

- capture `tool_event` rows from agent tool streams and extension delivery fan-in seams,
- include tool/result metadata and exfiltration-oriented signals,
- keep this separate to avoid conflating abuse-decision logging with channel/tool instrumentation rollout.

## Final Pre-Posting Checklist

- [ ] Confirm owners/reviewers for each ticket (gateway, security, integrations).
- [ ] Confirm rollout order (recommended: B -> A -> C -> D -> E).
- [ ] Confirm each ticket links this pack and explicitly references overlap boundaries above.
- [ ] Confirm no ticket language claims replacement of existing throttles or open PR work.
