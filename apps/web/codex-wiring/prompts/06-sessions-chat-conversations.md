# Ticket 06 — Sessions + Chat + Conversations Wiring

## Goal
Make sessions and chat fully live across agent session pages and conversation routes, using gateway RPCs and events.

## Background
- Session APIs exist: `sessions.list`, `sessions.patch`, `sessions.delete`.
- Chat APIs exist: `chat.history`, `chat.send`, `chat.abort`.
- `apps/web` conversation routes currently use mock data.

## Scope
- Use gateway sessions for conversation list + detail views.
- Use `chat.history` / `chat.send` / `chat.abort` for chat.
- Hook streaming event handling (via Ticket 02).

## Requirements
1. **Sessions list**
   - Replace mock session data with `sessions.list`.
2. **Conversation routes**
   - Treat conversation IDs as session keys (recommended).
   - Use `chat.history` for message list.
3. **Mutations**
   - Support `sessions.patch` (labels/tags) and `sessions.delete`.
4. **Streaming**
   - Ensure streaming updates from gateway events update UI.

## Fixed Decisions (Do Not Re‑decide)
- Conversation IDs **are** `sessionKey` (no new conversation API).
- Chat history uses `chat.history` with `limit` (default 100).
- Chat send requires `idempotencyKey` and returns `runId`.
- Session list uses `sessions.list` with `includeLastMessage` + `includeDerivedTitles` enabled.

## Required Decisions (Blockers)
1. **Session sorting**
   - **Question:** what is the default sort for session lists?
   - **Allowed answers:** `lastMessageAt desc`, `updatedAt desc`, `createdAt desc`
   - **Required response format:** single literal from list.
2. **Pagination**
   - **Question:** should sessions list use paging or a fixed limit?
   - **Allowed answers:** `fixed-limit` or `paged`
   - **Required response format:** single literal from list (if `paged`, include page size).

## Files to Touch (expected)
- `apps/web/src/hooks/queries/useSessions.ts`
- `apps/web/src/routes/conversations/*`
- `apps/web/src/routes/agents/$agentId/session/$sessionKey.tsx`
- `apps/web/src/hooks/useChatBackend.ts`

## Acceptance Criteria
- Conversation list shows real sessions.
- Chat history loads from gateway and updates live while streaming.
- Session metadata changes persist via `sessions.patch`.

## Testing
- Manual: send a chat message, verify new history entry.
- Manual: abort a chat run; streaming stops.
