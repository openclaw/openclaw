import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { capToolResultMessages, pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    // ── Per-result hard cap (always, not TTL-gated) ─────────────────────
    // Prevents a single oversized tool result from blowing out the context
    // window before the ratio-based pruner gets a chance to act.
    const maxResultChars = runtime.settings.maxToolResultChars;
    let messages = event.messages as AgentMessage[];
    let didCap = false;
    if (maxResultChars > 0) {
      const capped = capToolResultMessages(messages, maxResultChars, runtime.isToolPrunable);
      if (capped !== messages) {
        messages = capped;
        didCap = true;
      }
    }

    // ── Ratio-based pruning (TTL-gated) ─────────────────────────────────
    if (runtime.settings.mode === "cache-ttl") {
      const ttlMs = runtime.settings.ttlMs;
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      const ttlExpired = lastTouch != null && ttlMs > 0 && Date.now() - lastTouch >= ttlMs;

      if (ttlExpired) {
        const next = pruneContextMessages({
          messages,
          settings: runtime.settings,
          ctx,
          isToolPrunable: runtime.isToolPrunable,
          contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
        });

        if (next !== messages) {
          messages = next;
          runtime.lastCacheTouchAt = Date.now();
          return { messages };
        }
      }
    }

    // Return capped messages if per-result cap changed anything.
    if (didCap) return { messages };
    return undefined;
  });
}
