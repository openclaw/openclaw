import { emitAgentEvent } from "../infra/agent-events.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

export function emitFirstProgressOnce(
  ctx: {
    params: Pick<EmbeddedPiSubscribeContext["params"], "runId" | "onAgentEvent">;
    state: Pick<EmbeddedPiSubscribeContext["state"], "firstProgressEmitted">;
  },
  source: "assistant" | "tool",
  meta: Record<string, unknown> = {},
): void {
  if (ctx.state.firstProgressEmitted) {
    return;
  }
  ctx.state.firstProgressEmitted = true;
  const data = {
    phase: "first-progress",
    source,
    ...meta,
    progressedAt: Date.now(),
  };
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "lifecycle",
    data,
  });
  void ctx.params.onAgentEvent?.({
    stream: "lifecycle",
    data: { phase: "first-progress", source, ...meta },
  });
}
