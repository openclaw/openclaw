# Ticket 12 — Memories API Wiring (Graph/Memory Track)

## Goal
Replace mock memories UI with a real memory API aligned to the Graph/Memory track docs.

## Background
- Memories UI uses mock data (`useMemories`, `useMemorySearch`).
- Opus memory/graph track: `apps/web/ux-opus-design/14-GRAPH-DB-INTEGRATION.md` and `15-INGESTION-AND-RETRIEVAL-PIPELINE.md`.

## Scope
- Define `memory.*` RPCs in gateway (or HTTP endpoints) for list/search/create/update/delete.
- Wire UI to the new API.

## Requirements
1. **New RPCs**
   - `memory.list`, `memory.search`, `memory.create`, `memory.update`, `memory.delete`.
2. **UI wiring**
   - Replace mock query hooks with real API calls.
   - Support tag filters and search.

## Required Decisions (Blockers)
1. **Memory data model**
   - **Question:** what is the canonical Memory object shape?
   - **Allowed answers:** define explicit fields (id, content, tags, source, createdAt, updatedAt, embeddings?, etc.)
   - **Required response format:** JSON schema-like table with `field`, `type`, `required`, `notes`.
2. **Storage backend**
   - **Question:** where does memory live initially?
   - **Allowed answers:** `sqlite` or `graph-service` or `hybrid`
   - **Required response format:** single literal from list.
3. **Search semantics**
   - **Question:** should `memory.search` be keyword, vector, or hybrid?
   - **Allowed answers:** `keyword`, `vector`, `hybrid`
   - **Required response format:** single literal from list.

## Files to Touch (expected)
- `apps/web/src/hooks/queries/useMemories.ts`
- `apps/web/src/hooks/mutations/useMemoryMutations.ts`
- `apps/web/src/routes/memories/index.tsx`
- Gateway files under `src/gateway/server-methods/*` (new handlers)

## Acceptance Criteria
- Memories list + search work against gateway.
- Create/update/delete work end‑to‑end.

## Testing
- Manual: create memory, search, update, delete.
