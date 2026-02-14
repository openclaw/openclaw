# OpenClaw Dispatch Tools Plugin

This plugin is the control-plane bridge. It should expose only the closed dispatch actions and forward them to dispatch-api.

## Rules

- no direct ticket mutation in plugin process
- no business-state writes outside dispatch-api
- tool schemas must match `/src/contracts/v0.ts`
- plugin config must include dispatch-api base URL and auth settings

## Implemented v0 bridge actions

- `ticket.create` -> `POST /tickets`
- `ticket.triage` -> `POST /tickets/{ticketId}/triage`
- `schedule.propose` -> `POST /tickets/{ticketId}/schedule/propose`
- `schedule.confirm` -> `POST /tickets/{ticketId}/schedule/confirm`
- `assignment.dispatch` -> `POST /tickets/{ticketId}/assignment/dispatch`
- `tech.check_in` -> `POST /tickets/{ticketId}/tech/check-in`
- `tech.request_change` -> `POST /tickets/{ticketId}/tech/request-change`
- `approval.decide` -> `POST /tickets/{ticketId}/approval/decide`
- `closeout.add_evidence` -> `POST /tickets/{ticketId}/evidence`
- `tech.complete` -> `POST /tickets/{ticketId}/tech/complete`
- `qa.verify` -> `POST /tickets/{ticketId}/qa/verify`
- `billing.generate_invoice` -> `POST /tickets/{ticketId}/billing/generate-invoice`
- `ticket.get` -> `GET /tickets/{ticketId}`
- `closeout.list_evidence` -> `GET /tickets/{ticketId}/evidence`
- `ticket.timeline` -> `GET /tickets/{ticketId}/timeline`

Unknown tools and role/tool mismatches are rejected fail closed by the bridge before calling dispatch-api.
