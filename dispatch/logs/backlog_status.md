# Backlog Status (Derived, Do Not Edit Source CSV)

| Story ID | Epic | Priority | Status | Notes |
|---|---|---|---|---|
| STORY-01 | EPIC-01: v0 Dispatch API Spine | P0 | COMPLETE | Implemented command enforcement endpoints (`POST /tickets`, `POST /tickets/{id}/triage`, `POST /tickets/{id}/schedule/confirm`, `POST /tickets/{id}/assignment/dispatch`) with required idempotency key, replay semantics, payload-mismatch `409`, fail-closed transition checks, and audit+transition writes. Node-native integration tests pass. |
| STORY-02 | EPIC-01: v0 Dispatch API Spine | P0 | COMPLETE | Implemented `GET /tickets/{ticketId}/timeline` with fail-closed UUID validation, deterministic ordering (`created_at ASC, id ASC`), and required audit field coverage checks backed by node-native tests. |
| STORY-03 | EPIC-02: Postgres Schema + Migrations | P0 | COMPLETE | Implemented in `dispatch/db/migrations/001_init.sql`; validated on clean Postgres DB with fail-closed checks. |
| STORY-04 | EPIC-03: Closed Toolset + Integration | P0 | COMPLETE | Implemented closed tool bridge with allowlisted tool-to-endpoint mappings, deny-by-default unknown-tool rejection, per-role bridge gating, and request/correlation propagation validation via node-native integration tests. |
| STORY-05 | EPIC-03: Closed Toolset + Integration | P0 | COMPLETE | Added authoritative server-side role/tool/state authorization hardening, enforced endpoint tool-name checks (`TOOL_NOT_ALLOWED`), centralized state-context policy checks, and synchronized bridge/API policies via shared module with node-native coverage. |
| STORY-06 | EPIC-04: Evidence + Incident Templates | P0 | PENDING | Evidence template policy model not yet implemented. |
| STORY-07 | EPIC-04: Evidence + Incident Templates | P0 | PENDING | Evidence API/object-store integration not yet implemented. |
| STORY-08 | EPIC-05: E2E Proof | P0 | PENDING | Depends on endpoint/tool/audit/evidence enforcement chain. |
| STORY-09 | EPIC-06: Observability | P1 | PENDING | Not in P0 spine. |
| STORY-10 | EPIC-07: UX (v0 minimal) | P1 | PENDING | Not in P0 spine. |
