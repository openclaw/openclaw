import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../infra/agent-events.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

export function handleTurnStart(ctx: EmbeddedPiSubscribeContext) {
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "turn",
    data: { phase: "start" },
  });
  void ctx.params.onAgentEvent?.({
    stream: "turn",
    data: { phase: "start" },
  });
}

export function handleTurnEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { toolResults?: unknown },
) {
  const toolResultsCount = Array.isArray(evt.toolResults) ? evt.toolResults.length : 0;
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "turn",
    data: { phase: "end", toolResultsCount, endedAt: Date.now() },
  });
    data: { phase: "end", toolResultsCount },
  });
  void ctx.params.onAgentEvent?.({
    stream: "turn",
    data: { phase: "end", toolResultsCount },
  });
}
