import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import {
  extractToolResultText,
  tryParseA2UIOperations,
  groupBySurface,
  A2UI_OPERATIONS_KEY,
} from "./a2ui.js";
import {
  getWriter,
  getMessageId,
  pushToolCallId,
  popToolCallId,
  isClientTool,
  setClientToolCalled,
} from "./tool-store.js";

// ---------------------------------------------------------------------------
// before_tool_call / tool_result_persist hooks
//
// These translate the OpenClaw agent's server-side tool lifecycle into AG-UI
// TOOL_CALL_* events on the SSE stream. They are registered in registerFull()
// (index.ts) and exercised directly by tool-hooks.test.ts.
// ---------------------------------------------------------------------------

interface BeforeToolCallEvent {
  toolName: string;
  params?: Record<string, unknown>;
}

interface ToolCallContext {
  sessionKey?: string;
}

/**
 * Handles the `before_tool_call` OpenClaw hook.
 * Emits TOOL_CALL_START + TOOL_CALL_ARGS (and TOOL_CALL_END for client tools).
 */
export function handleBeforeToolCall(event: BeforeToolCallEvent, ctx: ToolCallContext): void {
  const sk = ctx.sessionKey;
  if (!sk) {
    return;
  }
  const writer = getWriter(sk);
  if (!writer) {
    return;
  }
  // Marked client/frontend + state-writer tools are emitted by the HTTP
  // handler's pendingToolCalls path (client tools) or intercepted into
  // STATE_SNAPSHOTs (state writers). The writer is now registered on EVERY turn
  // so BACKEND (server-side) tools render even when the turn also carries client
  // tools — so skip the marked names here to avoid a duplicate TOOL_CALL_*
  // sequence for the same call.
  if (isClientTool(sk, event.toolName)) {
    // Client/frontend tool: the HTTP handler emits its TOOL_CALL_* events via
    // the pendingToolCalls path. Record that a client tool fired so the handler
    // suppresses any trailing assistant text and ends the run for the browser
    // to execute the tool.
    setClientToolCalled(sk);
    return;
  }
  // Server (backend) tool: emit START + ARGS and push the id so
  // tool_result_persist can emit TOOL_CALL_RESULT + TOOL_CALL_END after
  // execute() completes.
  const toolCallId = `tool-${randomUUID()}`;
  writer({
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: event.toolName,
  });
  if (event.params && Object.keys(event.params).length > 0) {
    writer({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify(event.params),
    });
  }
  pushToolCallId(sk, toolCallId);
}

/**
 * Handles the `tool_result_persist` OpenClaw hook.
 * Emits TOOL_CALL_RESULT + TOOL_CALL_END for server-side tools.
 */
export function handleToolResultPersist(
  event: Record<string, unknown>,
  ctx: ToolCallContext,
): void {
  const sk = ctx.sessionKey;
  if (!sk) {
    return;
  }
  const writer = getWriter(sk);
  const toolCallId = popToolCallId(sk);
  const messageId = getMessageId(sk);
  if (writer && toolCallId && messageId) {
    // Extract actual tool result text from event.message.content
    const msg = (event as Record<string, unknown>).message as { content?: unknown } | undefined;
    const resultText = msg?.content ? extractToolResultText(msg.content) : "";

    // Use a dedicated messageId for the tool result so it doesn't collide
    // with the text message messageId. Tool events are linked via toolCallId.
    const toolResultMessageId = `msg-tool-${toolCallId}`;
    writer({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId: toolResultMessageId,
      content: resultText,
    });

    // Detect A2UI and emit ACTIVITY_SNAPSHOT per surface
    const a2uiOps = tryParseA2UIOperations(resultText);
    if (a2uiOps) {
      const groups = groupBySurface(a2uiOps);
      for (const [surfaceId, ops] of groups) {
        writer({
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: `a2ui-surface-${surfaceId}-${toolCallId}`,
          activityType: "a2ui-surface",
          content: { [A2UI_OPERATIONS_KEY]: ops },
          replace: true,
        });
      }
    }

    writer({
      type: EventType.TOOL_CALL_END,
      toolCallId,
    });
  }
}
