# Ticket 10 — Workstreams/Goals/Rituals/Jobs Implementation

## Goal
Replace mock data for Workstreams, Goals, Rituals, and Jobs with live gateway APIs based on the mapping decision from Ticket 09.

## Background
- Mock hooks: `useWorkstreams`, `useGoals`, `useRituals`, jobs route mock data.
- Gateway APIs available: `overseer.*`, `automations.*`, `cron.*`.

## Scope
- Implement real query/mutation hooks.
- Update routes and components to consume live data.
- Support create/update/run/cancel flows matching the selected API mapping.

## Requirements
- **Workstreams**
  - Map to chosen API (Overseer or Automations).
  - Implement list + detail + status updates.
- **Goals**
  - Map to Overseer (or chosen API).
  - Implement create, pause/resume, status.
- **Rituals**
  - Map to Cron or Automations.
  - Implement list + run + enable/disable.
- **Jobs**
  - Map to Cron (if chosen).

## Files to Touch (expected)
- `apps/web/src/hooks/queries/useWorkstreams.ts`
- `apps/web/src/hooks/queries/useGoals.ts`
- `apps/web/src/hooks/queries/useRituals.ts`
- `apps/web/src/routes/workstreams/*`
- `apps/web/src/routes/goals/*`
- `apps/web/src/routes/rituals/*`
- `apps/web/src/routes/jobs/*`

## Dependencies
- Ticket 09 mapping decision must be completed first.

## Fixed Decisions (Do Not Re‑decide)
- Implement **exactly** the mapping chosen in Ticket 09 decision doc.
- Do not invent new RPCs here; if missing, raise in the Ticket 09 gaps list.

## Acceptance Criteria
- All four areas show live data from gateway.
- Key actions (create/run/pause/delete) function end‑to‑end.
- No mock data remains in these areas.

## Testing
- Manual: verify list + detail views for each area.
- Manual: run a job/ritual and see status updates.
