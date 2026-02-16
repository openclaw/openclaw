# STORY-04 Implementation Contract

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Timestamp baseline: 2026-02-13 PST
Story: `STORY-04: Closed tool bridge mapping (tools -> dispatch-api)`

## Goal

Implement a closed dispatch tool bridge that:

- exposes only allowlisted tools,
- maps each exposed tool to a dispatch-api endpoint,
- rejects unknown/unapproved tool invocations fail-closed,
- propagates `request_id` and `correlation_id` into dispatch-api/audit paths.

## Bridge Scope (this cycle)

Only tools backed by currently implemented dispatch-api endpoints are exposed:

| Tool name             | Method | Endpoint                                  |
| --------------------- | ------ | ----------------------------------------- |
| `ticket.create`       | `POST` | `/tickets`                                |
| `ticket.triage`       | `POST` | `/tickets/{ticketId}/triage`              |
| `schedule.confirm`    | `POST` | `/tickets/{ticketId}/schedule/confirm`    |
| `assignment.dispatch` | `POST` | `/tickets/{ticketId}/assignment/dispatch` |
| `ticket.timeline`     | `GET`  | `/tickets/{ticketId}/timeline`            |

Any other tool name is denied by default.

## Role Allowlist (bridge layer)

- `ticket.create`: `dispatcher`, `agent`
- `ticket.triage`: `dispatcher`, `agent`
- `schedule.confirm`: `dispatcher`, `customer`
- `assignment.dispatch`: `dispatcher`
- `ticket.timeline`: `dispatcher`, `agent`, `customer`, `tech`, `qa`, `approver`, `finance`

Bridge rejects role/tool mismatches before making API calls.

## Invocation Envelope

Tool handlers accept:

- `actor_id` (required)
- `actor_role` (required)
- `actor_type` (optional; defaults to `AGENT`)
- `request_id` (optional UUID; generated if absent)
- `correlation_id` (optional; generated if absent)
- `trace_id` (optional)
- `ticket_id` (required for ticket-scoped tools)
- `payload` (required for mutating tools)

## Header Propagation

Mutating tool calls set:

- `Idempotency-Key: <request_id>`
- `X-Actor-Id`, `X-Actor-Role`, `X-Actor-Type`
- `X-Tool-Name`
- `X-Correlation-Id`
- optional `X-Trace-Id`

Read tool calls set correlation/trace headers only.

## Error Contract (fail-closed)

Bridge throws deterministic errors with structured fields:

- `code`
- `status`
- `message`
- `request_id`
- `correlation_id`
- `tool_name`

Codes:

- `UNKNOWN_TOOL`
- `TOOL_ROLE_FORBIDDEN`
- `INVALID_REQUEST`
- `INVALID_TICKET_ID`
- `DISPATCH_API_ERROR`
- `DISPATCH_API_TIMEOUT`
- `DISPATCH_API_UNREACHABLE`

## Logging Contract

Bridge emits structured logs for each invocation:

- phase `request` and `response`
- `tool_name`
- `endpoint`
- `request_id`
- `correlation_id`
- `status` (response phase)

This satisfies acceptance for invocation envelope observability at the bridge layer.
