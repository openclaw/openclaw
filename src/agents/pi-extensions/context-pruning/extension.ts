import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { updateSessionStoreEntry } from "../../../config/sessions.js";
import { CHARS_PER_TOKEN_ESTIMATE, estimateContextChars, pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

/**
 * Persist the post-pruning token estimate to `sessions.json` so that
 * dashboards and monitoring tools see up-to-date `contextTokens`
 * immediately — not only after the next message arrives.
 *
 * Runs fire-and-forget: a failure here must never block the agent run.
 */
function persistPrunedTokenCount(params: {
  storePath: string;
  sessionKey: string;
  estimatedTokens: number;
}): void {
  const { storePath, sessionKey, estimatedTokens } = params;
  updateSessionStoreEntry({
    storePath,
    sessionKey,
    update: async (entry) => ({
      contextTokens: estimatedTokens,
      totalTokens: Math.max(estimatedTokens, (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0)),
      updatedAt: Date.now(),
    }),
  }).catch(() => {
    // Swallow — best-effort persistence; the next agent run will
    // re-sync anyway.
  });
}

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
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

    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
    });

    if (next === event.messages) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
    }

    // Persist the reduced token count to sessions.json immediately
    // so dashboards reflect the post-pruning state.  (#14857)
    if (runtime.sessionKey && runtime.storePath) {
      const estimatedTokens = Math.round(estimateContextChars(next) / CHARS_PER_TOKEN_ESTIMATE);
      persistPrunedTokenCount({
        storePath: runtime.storePath,
        sessionKey: runtime.sessionKey,
        estimatedTokens,
      });
    }

    return { messages: next };
  });
}
