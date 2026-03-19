# Delegation Invariants (Draft): Confirm / Stop(Takeover) / Receipts

> Status: **Initial draft for discussion** (docs-only).
>
> Goal: define a minimal "thin waist" invariant layer + stable hook points to keep runtimes **agent-light** as agents shift from assisting to delegated execution.
>
> Non-goal: standardize all tools, workflows, UIs, or provider integrations.

---

## Motivation

As interaction shifts from **Human-App-Cloud** to **Human-Agent-Cloud**, several details that used to be "in-app UX" become **cross-ecosystem invariants**:

- **Confirm** must represent execution authority (scope/limits/TTL) and be revocable, not a generic click.
- **Stop/Takeover** must be deterministic (stop step vs stop chain) and specify takeover semantics.
- **Receipts** must anchor accountability before irreversible commits.

Without a thin waist, ecosystems drift to:

1) **Fragmentation / lock-in** (each runtime defines its own semantics)
2) **Core creep / bloat** (policies/adapters accumulate until the runtime becomes the next platform/OS)

---

## Terminology (minimal)

- **Workflow**: a multi-step plan that may include tool calls and UI actions.
- **Step**: one atomic action within a workflow.
- **Confirm**: a user-granted authority event for one or more steps, bounded by scope/limits/time.
- **Stop / Takeover**: an intervention event that halts execution and optionally transfers control.
- **Receipt**: an auditable record of what was executed and under what authority.
- **Authorization reference**: an identifier linking actions/receipts back to the Confirm event.

---

## Invariants (thin waist MVP)

This draft defines only **three primitives** and their **minimal required fields**.

---

## CONFIRM (execution authority)

**Goal:** encode bounded, revocable authority with explicit scope.

Required fields (minimal):

- `confirm_id`
- `timestamp` (ISO-8601)
- `scope` (what is authorized)
- `limits` (budget/cap/etc.)
- `ttl_seconds`
- `revocable` (boolean)
- `risk_level` (e.g., `"low" | "medium" | "high"`)

Scope (minimal structure):

- `workflow_id`
- `step_ids` (optional; if omitted, applies to a workflow scope)
- `targets` (optional; resource identifiers)
- `capabilities` (optional; tool categories or verbs)

```json
{
  "type": "CONFIRM",
  "confirm_id": "confirm_42c1",
  "timestamp": "2026-03-19T08:12:00Z",
  "scope": {
    "workflow_id": "wf_9f3a",
    "step_ids": ["step_2", "step_3"],
    "targets": ["airline_portal/account_123"],
    "capabilities": ["purchase", "submit_form"]
  },
  "limits": {
    "budget_usd": 800,
    "max_side_effects": 1
  },
  "ttl_seconds": 900,
  "revocable": true,
  "risk_level": "high"
}
```

---

## STOP / TAKEOVER (deterministic intervention)

**Goal:** make "Stop" deterministic and auditably scoped in a multi-step delegated workflow.

Required fields (minimal):

- `request_id`
- `timestamp` (ISO-8601)
- `workflow_id`
- `stop_scope` (`"step" | "chain"`)

Optional fields (recommended):

- `step_id` (required if `stop_scope="step"`)
- `takeover_mode` (`"human" | "pause" | "delegate_to_other_agent"`)
- `reason`

```json
{
  "type": "STOP",
  "request_id": "stop_001",
  "timestamp": "2026-03-19T08:14:10Z",
  "workflow_id": "wf_9f3a",
  "stop_scope": "chain",
  "takeover_mode": "human",
  "reason": "User requested immediate halt"
}
```

---

## RECEIPT (audit record before commit)

**Goal:** create an auditable record before irreversible commits.

Required fields (minimal):

- `receipt_id`
- `timestamp` (ISO-8601)
- `actor` (runtime/gateway/agent identity)
- `workflow_id`
- `action`
- `target`
- `authorization_ref` (e.g., `confirm_id`)
- `result` (`"success" | "failure" | "partial"`)

Optional fields (recommended):

- `step_id`
- `side_effects` (summary)
- `evidence_refs` (links to logs/txns/screenshots)
- `error` (if `result="failure"`)

```json
{
  "type": "RECEIPT",
  "receipt_id": "rcpt_001",
  "timestamp": "2026-03-19T08:15:30Z",
  "actor": "openclaw.gateway",
  "workflow_id": "wf_9f3a",
  "step_id": "step_3",
  "action": "book_flight",
  "target": "airline_portal/account_123",
  "authorization_ref": "confirm_42c1",
  "result": "success",
  "side_effects": {
    "charged_usd": 742,
    "confirmation_code": "ABC123"
  },
  "evidence_refs": ["txn:ABC123", "log:gateway/2026-03-19/8f2e"]
}
```

---

## Stable hook points (keep runtime agent-light)

**Goal:** allow governance/policy/auditing to be pluggable or externalizable (service/cloud-side) rather than accumulating inside core.

Suggested hooks (names are illustrative):

- `before_confirm(confirm_request)`
- `after_confirm(confirm_record)`
- `before_execute(action_request)`
- `after_execute(action_result)`
- `on_stop(stop_request)`
- `on_takeover(takeover_request)`
- `emit_receipt(receipt_record)`

Notes:

- This is **not** attempting to define a universal tool protocol.
- Tool routing protocols (e.g., MCP/A2A/tool routers) help integration but do not guarantee these invariants.
- UI fallback can remain a universal path for closed/legacy systems, while structured execution can use faster paths where available.
