import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { createEmptyPruneStats, pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

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

export default function contextPruningExtension(api: ExtensionAPI): void {
  let turnCounter = 0;

  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    turnCounter++;

    if (runtime.settings.mode === "cache-ttl") {
      const ttlMs = runtime.settings.ttlMs;
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      if (!lastTouch || ttlMs <= 0) {
        return undefined;
      }
      if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) {
        return undefined;
      }
    }

    const emitter = runtime.lifecycleEmitter;
    const stats = emitter ? createEmptyPruneStats() : undefined;

    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
      stats,
    });

    if (next !== event.messages && emitter && stats) {
      const beforeTokens = sumEstimateTokens(event.messages);
      const afterTokens = sumEstimateTokens(next);
      emitter.emit({
        turn: turnCounter,
        rule: "prune:pass",
        beforeTokens,
        afterTokens,
        freedTokens: beforeTokens - afterTokens,
        details: { ...stats },
      });
    }

    if (next === event.messages) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
    }

    return { messages: next };
  });
}
