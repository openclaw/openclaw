# PRD — v0 Minimum Shippable Dispatch (AI-First Dispatch Agent)

## 1. Problem statement
Door service dispatch is operationally fragile:
- requests arrive incomplete and inconsistent (phone/SMS/email/web)
- urgency and safety risks vary widely (egress/ADA/security)
- tech assignment depends on skill, availability, parts, access windows
- “done” requires proof (photos/tests/signatures) or callbacks explode
- enterprise-scale customers require SLA tracking, approvals, and auditability

We are building an **AI-first dispatch agent** that can run operations for a door service company:
- **AI** performs intake, triage, scheduling proposals, and comms drafting
- **dispatch-api** is the enforcement service that validates/records every mutation
- a **closed toolset** ensures agents cannot mutate outside permitted flows

## 2. Goals (v0)
### Operational
- Convert inbound requests into normalized work orders with consistent structure
- Provide reliable scheduling/dispatch with human override
- Enforce evidence capture and completion verification
- Reduce cycle time (request → scheduled → completed → invoiced)

### Engineering/control plane
- Every mutation is **idempotent**, validated, and recorded
- Every mutation emits an **append-only audit event** with correlation IDs
- Tool access is **allowlisted by role + state**
- One canonical E2E scenario proves the full chain locally and in CI

## 3. Non-goals (explicitly deferred)
- Full optimization (route planning, multi-objective scheduling)
- Dynamic pricing engines
- Full third-party provider marketplace onboarding (beyond basic Provider model)
- Complex rule engine (v0 uses deterministic “incident type templates” + simple rules)

## 4. Users and roles
### Internal (v0)
- **Dispatcher/Ops**: monitors queue, overrides AI, approves changes
- **Technician**: executes work, captures evidence, requests NTE changes
- **Admin/Finance**: reviews invoices, runs reports

### External (v0)
- **Customer requester**: submits request, receives status updates
- **Approver** (enterprise): approves >NTE or proposal

## 5. Core user stories (v0)
1. Intake → Work Order
- As a dispatcher, I need messy inbound requests to become structured work orders with correct site/contact details.
2. Triage + SLA
- As a dispatcher, I need priority and SLA timers based on incident type and risk.
3. Scheduling
- As a customer, I need 1–3 appointment options and reminders.
4. Dispatch
- As a dispatcher, I need to assign the right tech and produce a job packet.
5. Field execution + evidence
- As a tech, I need checklists and required evidence prompts (before/after photos, tests, signature).
6. Change control (NTE)
- As a tech, I need to request an NTE increase with evidence; as an approver, I need to approve/deny quickly.
7. Verification + invoice readiness
- As finance, I need consistent closeout packages that can be invoiced without chasing.

## 6. v0 functional requirements (must)
### Work order lifecycle enforcement
- State machine defined in `docs/02_Workflows_and_State_Machine.md`
- Only dispatch-api can transition states
- Transition requires:
  - valid actor role
  - valid tool/command name
  - required fields for that transition
  - audit event emission

### Idempotency
- Every command endpoint accepts `request_id` (UUID) or `Idempotency-Key` header
- Replays return same response; no duplicate transitions/events

### Audit truth
For every mutation, record:
- ticket_id
- previous_state → new_state
- actor_type (human/tool/agent/system)
- actor_id (user/service identity)
- tool_name
- request_id + correlation_id + trace_id
- diff payload (or snapshot pointers)
- timestamp

### Closed toolset
Only the following tools may mutate state (v0):
- `ticket.create`
- `ticket.triage`
- `schedule.propose`
- `schedule.confirm`
- `assignment.dispatch`
- `tech.check_in`
- `tech.request_change` (NTE/proposal)
- `approval.decide`
- `tech.complete`
- `qa.verify`
- `billing.generate_invoice`

Everything else is read-only.

### Evidence enforcement
Completion requires:
- minimum evidence per incident type (photos + notes)
- tech check-out and signature (or explicit “no signature” reason)
- failure to meet evidence => transition blocked (fail closed)

## 7. v0 success metrics
- % requests that reach “SCHEDULED” within X minutes/hours
- % jobs completed with full evidence package
- callback rate within 30 days
- SLA breach rate
- time from completion → invoice generated

## 8. Risks and mitigations
- AI hallucinating confirmations → enforce “proof” through dispatch-api
- tool abuse/prompt injection → closed toolset + allowlist + server-side authz
- incomplete intake → NEEDS_INFO state and structured follow-up questions

## 9. Acceptance criteria (v0 ship gate)
See `backlog/acceptance_criteria_checklist.md`.

