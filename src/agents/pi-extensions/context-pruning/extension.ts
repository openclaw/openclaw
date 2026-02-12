import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return runBeforeContextSendHook(event.messages, event.messages, ctx);
    }

    if (runtime.settings.mode === "cache-ttl") {
      const ttlMs = runtime.settings.ttlMs;
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      if (!lastTouch || ttlMs <= 0) {
        return runBeforeContextSendHook(event.messages, event.messages, ctx);
      }
      if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) {
        return runBeforeContextSendHook(event.messages, event.messages, ctx);
      }
    }

    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
    });

    if (runtime.settings.mode === "cache-ttl" && next !== event.messages) {
      runtime.lastCacheTouchAt = Date.now();
    }

    return runBeforeContextSendHook(next, event.messages, ctx);
  });
}

/**
 * Run the before_context_send plugin hook, giving plugins a chance to
 * modify the messages array after pruning but before it reaches the LLM.
 *
 * @param messages - The (possibly pruned) messages to send.
 * @param original - The original messages from the event, used to detect changes.
 */
function runBeforeContextSendHook(
  messages: ContextEvent["messages"],
  original: ContextEvent["messages"],
  _ctx: ExtensionContext,
): { messages: ContextEvent["messages"] } | undefined {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_context_send")) {
    // No hooks — return pruned messages if they differ from the original.
    return messages !== original ? { messages } : undefined;
  }

  const result = hookRunner.runBeforeContextSend({ messages }, {});

  const final = result?.messages ?? messages;
  return final !== original ? { messages: final } : undefined;
}
