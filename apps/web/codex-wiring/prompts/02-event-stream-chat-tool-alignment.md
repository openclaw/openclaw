# Ticket 02 — Event Stream Alignment (Chat + Tool Streams)

## Goal
Align `apps/web` streaming handlers with gateway event payloads (`chat` + `agent`) so chat deltas and tool outputs display correctly.

## Background
- Gateway emits `chat` + `agent` events (see `src/gateway/server-methods-list.ts`).
- `apps/web` expects `chat` + `tool` events in `useGatewayStreamHandler.ts`.
- Legacy UI uses `agent` stream with `stream=tool` and `stream=compaction`.

## Scope
- Update streaming handlers to parse `agent` events for tool output + compaction.
- Ensure text deltas only appear in message content (not tool output).
- Sync session store updates with gateway payloads.

## Requirements
1. **Chat event handling**
   - Handle `chat` events with `delta`, `final`, `aborted`, `error` states.
   - Update `useSessionStore` streaming content.
2. **Tool stream handling**
   - Consume `agent` event payloads with `stream=tool`.
   - Update tool calls in session store (start/update/result phases).
3. **Compaction events**
   - Handle `stream=compaction` with `{ phase: "start"|"end" }` for UI status.
4. **Event subscription**
   - Ensure handlers are registered on the unified gateway client.

## Event Payload References (Canonical)
- **Chat event (`event: "chat"`)** uses gateway schema:
  - `{ runId, sessionKey, seq, state: "delta"|"final"|"aborted"|"error", message?, errorMessage?, usage?, stopReason? }`
- **Agent event (`event: "agent"`)** uses gateway schema:
  - `{ runId, seq, stream, ts, data: Record<string, unknown> }`
  - `sessionKey` is often included by the gateway but is not guaranteed by schema; handle both.

## Fixed Mapping Rules
- Replace all `tool` event assumptions with **`agent`** events.
- Tool UI should only be updated from `agent` events where `stream === "tool"`.
- Compaction UI should only be updated from `agent` events where `stream === "compaction"`.

## Tool Stream Data Mapping (Use This Default)
- `toolCallId`: `data.toolCallId`
- `toolName`: `data.name`
- `status`:
  - `data.phase === "start"` → `running`
  - `data.phase === "finish" | "done"` → `done`
  - `data.phase === "error"` → `error`
- `input`: `data.input` (stringify if object)
- `output`: `data.output ?? data.result ?? data.text`
- If any field is missing, **do not throw**; update only the known fields.

## Files to Touch (expected)
- `apps/web/src/hooks/useGatewayStreamHandler.ts`
- `apps/web/src/hooks/queries/useSessions.ts`
- `apps/web/src/stores/useSessionStore.ts`
- `apps/web/src/components/domain/session/*` (if new UI indicators needed)

## Acceptance Criteria
- Tool outputs are shown in tool call UI (not mixed into message body).
- Chat streaming appears correctly in session chat UI.
- Compaction start/end events are visible (toast or status indicator).

## Out of Scope
- No change to gateway event payloads unless strictly required.

## Testing
- Manual: send a message that triggers tools; verify tool call UI updates.
- Manual: trigger compaction and see status indicator.
