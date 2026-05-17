import { emitAgentEvent } from "../../infra/agent-events.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { AcpRuntimeEvent } from "./types.js";

export function emitAcpRuntimeAgentEvent(params: {
  runId: string | undefined;
  sessionKey?: string;
  event: AcpRuntimeEvent;
  includeAssistantOutput?: boolean;
}) {
  const runId = normalizeOptionalString(params.runId);
  if (!runId) {
    return;
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const base = {
    runId,
    ...(sessionKey ? { sessionKey } : {}),
  };
  switch (params.event.type) {
    case "turn_started":
      emitAgentEvent({
        ...base,
        stream: "lifecycle",
        data: {
          phase: "turn_started",
          ...(params.event.mode ? { mode: params.event.mode } : {}),
          ...(params.event.requestId ? { requestId: params.event.requestId } : {}),
        },
      });
      return;
    case "status":
      emitAgentEvent({
        ...base,
        stream: "status",
        data: {
          text: params.event.text,
          ...(params.event.tag ? { tag: params.event.tag } : {}),
          ...(params.event.used != null ? { used: params.event.used } : {}),
          ...(params.event.size != null ? { size: params.event.size } : {}),
        },
      });
      return;
    case "tool_call":
      emitAgentEvent({
        ...base,
        stream: "tool",
        data: {
          text: params.event.text,
          ...(params.event.tag ? { tag: params.event.tag } : {}),
          ...(params.event.toolCallId ? { toolCallId: params.event.toolCallId } : {}),
          ...(params.event.status ? { status: params.event.status } : {}),
          ...(params.event.title ? { title: params.event.title } : {}),
        },
      });
      return;
    case "text_delta":
      if (!params.event.text || params.event.stream === "thought") {
        return;
      }
      if (params.includeAssistantOutput !== true) {
        return;
      }
      emitAgentEvent({
        ...base,
        stream: "assistant",
        data: {
          delta: params.event.text,
        },
      });
      return;
    case "done":
    case "error":
      return;
  }
}
