# STORY-05 Implementation Contract

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Timestamp baseline: 2026-02-13 PST
Story: `STORY-05: Server-side role/tool/state authorization hardening`

## Goal

Harden dispatch-api authorization so policy is enforced authoritatively at the API layer even if callers bypass the tool bridge.

## Scope

Applies to currently implemented command endpoints:

- `POST /tickets`
- `POST /tickets/{ticketId}/triage`
- `POST /tickets/{ticketId}/schedule/confirm`
- `POST /tickets/{ticketId}/assignment/dispatch`

## Policy Requirements

1. Role authorization:

- Actor role must be allowlisted for endpoint.
- Violations return `403 FORBIDDEN`.

2. Tool-to-endpoint authorization:

- `X-Tool-Name` must match allowlisted tool(s) for endpoint.
- Missing tool header defaults to endpoint default tool.
- Mismatched tool name returns `403 TOOL_NOT_ALLOWED`.

3. State-context authorization:

- Endpoint state preconditions are enforced deterministically server-side.
- Invalid state context returns `409 INVALID_STATE_TRANSITION` with `from_state` and `to_state`.

4. Policy synchronization:

- Bridge and API both consume a shared policy module (`dispatch/shared/authorization-policy.mjs`) for tool/endpoint/role mappings.

## Deterministic Error Codes

- `FORBIDDEN` (role not allowed)
- `TOOL_NOT_ALLOWED` (tool/header mismatch for endpoint)
- `INVALID_STATE_TRANSITION` (state context not allowed)

## Tests

Add node-native integration test validating:

- API rejects valid-role-but-wrong-tool endpoint call.
- API rejects forbidden role.
- API rejects invalid state-context and preserves no extra successful mutation audit rows.
- Bridge and API policy mapping consistency check from shared policy.
