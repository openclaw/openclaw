# Giri Implementation Status

## Snapshot

- Branch baseline: merged frontend + backend on `giri-corre-features`
- Goal: evening planning demo with Telegram coordination and conditional booking

## Completed

- Worktree merge completed (frontend + backend changes combined).
- Backend extension added: `extensions/evening-planner/`.
- Planner tool actions implemented:
  - `start_session`
  - `list_sessions`
  - `status`
  - `cancel_session`
  - `ingest_reply`
  - `search_venues`
  - `check_slots`
  - `prepare_booking`
  - `book_table`
- Gateway methods implemented:
  - `eveningplanner.list`
  - `eveningplanner.status`
- Telegram reply ingestion + sender matching wired.
- Deterministic timeout fallback to solo booking implemented.
- Swiggy live command wrappers with fixture fallback implemented.
- Session persistence implemented at `plugins/evening-planner/sessions.json`.
- Frontend macOS Talk overlay expanded workflow UI implemented (compact + drawer behavior).
- Reply parser fix landed for tentative responses (for example `"not sure"`/`"shayad"` now treated as tentative before weak yes matches).
- Targeted backend tests passing:
  - `extensions/evening-planner/src/parse-reply.test.ts`
  - `extensions/evening-planner/src/state-machine.test.ts`
  - `extensions/evening-planner/src/swiggy.test.ts`

## Partial / In Progress

- Frontend-backend workflow signal contract is only partially integrated:
  - Overlay supports `demo.workflow.*` streams.
  - Planner backend currently does not emit those dedicated stream events directly.

## Not Implemented Yet

- PSTN/native call bridge (`call_contact`, `call_restaurant`) is not wired.
- Direct frontend-triggerable session creation API outside agent/tool path is not added.
- Calendar/map post-booking actions are not implemented in this pass.

## Current Bottlenecks

- Signal gap between planner state updates and overlay's preferred structured event streams.
- External dependencies for live mode:
  - Telegram token + pairing approval
  - Swiggy CLI/auth path when fixture mode is disabled
- Local macOS validation depends on Swift toolchain compatibility.

## Validation Notes

- Backend extension tests pass on this branch.
- Local `apps/macos` test/build can fail if installed Swift tools version is below package requirement.
