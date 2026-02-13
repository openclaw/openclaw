# Tool Surface + OpenClaw Integration (Closed Toolset)

## 1) Why a closed toolset
Dispatch is an operational authority surface. The primary risks:
- prompt injection leading to unauthorized actions
- hallucinated confirmations (“scheduled!”) without real state mutation
- silent skips that appear successful

A closed toolset means:
- the agent can only call **explicit, versioned tools**
- each tool maps 1:1 to **dispatch-api commands**
- dispatch-api performs the real enforcement and logs every mutation

## 2) Tool inventory (v0, mutating)
| Tool name | Purpose | dispatch-api endpoint | Allowed roles | Required ticket states |
|---|---|---|---|---|
| ticket.create | Create new ticket | POST /tickets | dispatcher/agent | none |
| ticket.triage | Set incident type/priority/NTE | POST /tickets/{id}/triage | dispatcher/agent | NEW, NEEDS_INFO |
| schedule.propose | Offer options | POST /tickets/{id}/schedule/propose | dispatcher/agent | READY_TO_SCHEDULE |
| schedule.confirm | Lock appointment | POST /tickets/{id}/schedule/confirm | dispatcher/customer | SCHEDULE_PROPOSED |
| assignment.dispatch | Assign tech/provider | POST /tickets/{id}/assignment/dispatch | dispatcher | SCHEDULED |
| tech.check_in | Start on-site | POST /tickets/{id}/tech/check-in | tech | DISPATCHED |
| tech.request_change | NTE increase/proposal | POST /tickets/{id}/tech/request-change | tech | IN_PROGRESS, ON_SITE |
| approval.decide | Approve/deny | POST /tickets/{id}/approval/decide | approver/dispatcher | APPROVAL_REQUIRED |
| tech.complete | Submit completion package | POST /tickets/{id}/tech/complete | tech | IN_PROGRESS |
| qa.verify | Verify | POST /tickets/{id}/qa/verify | qa/dispatcher | COMPLETED_PENDING_VERIFICATION |
| billing.generate_invoice | Invoice | POST /tickets/{id}/billing/generate-invoice | finance | VERIFIED |

Read-only tools (examples):
- ticket.get, ticket.timeline, site.get, asset.get, templates.list

## 3) Role-based allowlisting
Enforce at **two layers**:
1) **Tool bridge allowlist**: which tools are even exposed to a role/session
2) **dispatch-api authz**: authoritative enforcement, based on claims and ticket state

## 4) Tool invocation envelope (recommended)
A standard envelope prevents ambiguity and improves audit correlation:

```json
{
  "tool_name": "schedule.confirm",
  "request_id": "uuid",
  "correlation_id": "string",
  "actor": {
    "type": "HUMAN|AGENT|SERVICE",
    "id": "string",
    "role": "dispatcher|tech|finance|approver"
  },
  "payload": { "..." : "..." }
}
```

## 5) Packaging guidance (repo mapping)
If your repo resembles:
- `/src/plugins` (OpenClaw tools)
- `/dispatch/tools-plugin`

Then: convert tools into a **first-class extension**:
- `extensions/dispatch-tools/`
  - tool definitions (JSON)
  - tool handlers that call dispatch-api
  - allowlist config per role

## 6) “Fail closed” behavior
- If tool name is not allowlisted: reject
- If dispatch-api returns invalid transition: reject and surface error
- If evidence missing: reject completion; agent must request missing items

