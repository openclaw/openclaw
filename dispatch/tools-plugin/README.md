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
- `schedule.confirm` -> `POST /tickets/{ticketId}/schedule/confirm`
- `assignment.dispatch` -> `POST /tickets/{ticketId}/assignment/dispatch`
- `ticket.timeline` -> `GET /tickets/{ticketId}/timeline`

Unknown tools and role/tool mismatches are rejected fail closed by the bridge before calling dispatch-api.
