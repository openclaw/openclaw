import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { estimateContextUsageRatio, pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    const contextWindowTokensOverride =
      typeof runtime.contextWindowTokens === "number" &&
      Number.isFinite(runtime.contextWindowTokens) &&
      runtime.contextWindowTokens > 0
        ? runtime.contextWindowTokens
        : undefined;
    const forcePruneRatio = runtime.settings.forcePruneRatio;
    const bypassTtl =
      typeof forcePruneRatio === "number" &&
      estimateContextUsageRatio(
        event.messages,
        contextWindowTokensOverride ?? ctx.model?.contextWindow,
      ) >= forcePruneRatio;

    if (runtime.settings.mode === "cache-ttl" && !bypassTtl) {
      const ttlMs = runtime.settings.ttlMs;
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      if (!lastTouch || ttlMs <= 0) {
        return undefined;
      }
      if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) {
        return undefined;
      }
    }

    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride,
    });

    if (next === event.messages) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
    }

    return { messages: next };
  });
}
