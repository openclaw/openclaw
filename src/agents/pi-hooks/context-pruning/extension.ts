import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getContextPruningRuntime } from "./runtime.js";

let pruneContextMessagesPromise:
  | Promise<typeof import("./pruner.js").pruneContextMessages>
  | undefined;

async function getPruneContextMessages() {
  if (!pruneContextMessagesPromise) {
    pruneContextMessagesPromise = import("./pruner.js").then((mod) => mod.pruneContextMessages);
  }
  return await pruneContextMessagesPromise;
}

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

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

    const pruneContextMessages = await getPruneContextMessages();
    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
      dropThinkingBlocksForEstimate: runtime.dropThinkingBlocks,
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
