# Current Work Item

## Story ID
`STORY-05: Server-side role/tool/state authorization hardening`

## Epic
`EPIC-03: Closed Toolset + Integration`

## Priority
`P0`

## Acceptance Criteria (from backlog)
- Server-side role/tool/state authorization is enforced authoritatively for command paths.
- Bridge allowlist and dispatch-api authorization behavior are aligned and test-covered.
- Policy violations fail closed with deterministic error payloads.

## Why This Was Selected
`STORY-04` is now complete and provides closed tool bridge mapping with deny-by-default behavior. The next dependency-valid P0 item is authorization hardening to ensure tool-level and API-level policy checks remain consistent as command surface expands.

## Dependency Check
- Schema/migrations: satisfied (`STORY-03` complete).
- Command mutation path + idempotency: satisfied (`STORY-01` complete).
- Timeline + audit completeness: satisfied (`STORY-02` complete).
- Tool bridge mapping + role allowlist: satisfied (`STORY-04` complete).
- Remaining authz hardening before broader E2E proof: pending in this story.

## Deterministic Scope for Next Cycle
- Introduce explicit server-side role/tool/state authorization policy module for dispatch-api endpoints.
- Add deterministic fail-closed tests for unauthorized role/tool combinations and invalid state-context combinations.
- Ensure bridge and API policy tables are synchronized (single-source mapping or shared constants).
