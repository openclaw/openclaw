import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getGlobalPluginRegistry } from "../../../plugins/hook-runner-global.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);

    // Start with the original messages
    let messages = event.messages;

    // Apply context pruning if runtime is configured
    if (runtime) {
      let shouldPrune = true;

      if (runtime.settings.mode === "cache-ttl") {
        const ttlMs = runtime.settings.ttlMs;
        const lastTouch = runtime.lastCacheTouchAt ?? null;
        if (!lastTouch || ttlMs <= 0) {
          shouldPrune = false;
        } else if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) {
          shouldPrune = false;
        }
      }

      if (shouldPrune) {
        const pruned = pruneContextMessages({
          messages,
          settings: runtime.settings,
          ctx,
          isToolPrunable: runtime.isToolPrunable,
          contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
        });

        if (pruned !== messages) {
          messages = pruned;
          if (runtime.settings.mode === "cache-ttl") {
            runtime.lastCacheTouchAt = Date.now();
          }
        }
      }
    }

    // Run before_context_send hooks after pruning (or on original messages if no pruning)
    const registry = getGlobalPluginRegistry();
    if (registry) {
      const hookRunner = createHookRunner(registry);
      const hookResult = hookRunner.runBeforeContextSend(
        { messages },
        { sessionManager: ctx.sessionManager },
      );

      if (hookResult?.messages) {
        messages = hookResult.messages;
      }
    }

    // Return modified messages if they changed
    if (messages !== event.messages) {
      return { messages };
    }

    return undefined;
  });
}
