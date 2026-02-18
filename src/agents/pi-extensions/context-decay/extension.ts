import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { applyContextDecay, createEmptyDecayStats, type DecayStats } from "./decay.js";
import { getContextDecayRuntime } from "./runtime.js";

function sumEstimateTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    try {
      total += estimateTokens(msg);
    } catch {
      // estimateTokens can fail on malformed messages — skip
    }
  }
  return total;
}

/**
 * Pi extension that applies graduated context decay before each LLM call.
 * Hooks into the SDK "context" event to strip thinking blocks, apply
 * pre-computed tool-result summaries, strip aged tool results, and
 * enforce a hard message cap.
 */
export default function contextDecayExtension(api: ExtensionAPI): void {
  let turnCounter = 0;

  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextDecayRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    turnCounter++;

    const emitter = runtime.lifecycleEmitter;
    const stats: DecayStats | undefined = emitter ? createEmptyDecayStats() : undefined;

    const next = applyContextDecay({
      messages: event.messages,
      config: runtime.config,
      summaryStore: runtime.summaryStore,
      groupSummaryStore: runtime.groupSummaryStore,
      swappedFileStore: runtime.swappedFileStore,
      stats,
    });

    if (emitter && stats) {
      const beforeTokens = sumEstimateTokens(event.messages);
      const afterTokens = sumEstimateTokens(next);
      emitter.emit({
        turn: turnCounter,
        rule: "decay:pass",
        beforeTokens,
        afterTokens,
        freedTokens: beforeTokens - afterTokens,
        details: { ...stats },
      });
    }

    if (next === event.messages) {
      return undefined;
    }

    return { messages: next };
  });
}
