/**
 * Double-buffered context window extension for OpenClaw.
 *
 * Hooks into the Pi extension lifecycle to manage two context buffers,
 * enabling near-seamless context-window hops with background summarization.
 *
 * Extension events used:
 *   - `context` — intercepts the message list to inject the active buffer's
 *     view (summary + live messages) and to drive threshold checks.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveContextWindowTokens } from "../../compaction.js";
import { BufferManager, buildSummarizeDep } from "./buffer-manager.js";
import { getDoubleBufferRuntime } from "./runtime.js";

const log = createSubsystemLogger("double-buffer");

import { SessionTracker } from "./session-tracker.js";

/** Per-session buffer manager instances, keyed by session manager identity. */
const managers = new WeakMap<object, BufferManager>();

const tracker = new SessionTracker();

function getOrCreateManager(ctx: ExtensionContext): BufferManager | null {
  const runtime = getDoubleBufferRuntime(ctx.sessionManager);
  if (!runtime) {
    return null;
  }

  const key = ctx.sessionManager as object;
  let manager = managers.get(key);
  if (manager) {
    return manager;
  }

  // Resolve model (ctx.model may be undefined in some workflows).
  const model = ctx.model ?? runtime.model;
  if (!model) {
    log.warn(
      `No model available for double-buffer summarization. ` +
        `Extension disabled for this session.`,
    );
    return null;
  }

  const apiKey = runtime.apiKey;
  if (!apiKey) {
    log.warn(
      `No API key available for double-buffer summarization. ` +
        `Extension disabled for this session.`,
    );
    return null;
  }

  const contextWindowTokens = runtime.contextWindowTokens ?? resolveContextWindowTokens(model);
  const settings = runtime.settings;

  const summarize = buildSummarizeDep({
    model,
    apiKey,
    contextWindowTokens,
    customInstructions: settings.customInstructions,
  });

  manager = new BufferManager({
    settings,
    contextWindowTokens,
    deps: { summarize },
    initialSummary: runtime.initialSummary,
  });

  managers.set(key, manager);
  log.info(
    `Double-buffer manager initialized (checkpoint: ${(settings.checkpointThreshold * 100).toFixed(0)}%, ` +
      `swap: ${(settings.swapThreshold * 100).toFixed(0)}%, maxGenerations: ${settings.maxGenerations ?? "unlimited"}).`,
  );

  return manager;
}

export default function doubleBufferExtension(api: ExtensionAPI): void {
  api.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
    let manager = getOrCreateManager(ctx);
    if (!manager) {
      return undefined;
    }

    const messages = event.messages;
    if (!messages || messages.length === 0) {
      return undefined;
    }

    try {
      const key = ctx.sessionManager as object;
      const { action, newStartIndex } = tracker.evaluate(key, messages.length);

      // History shrank — destroy stale manager and rebuild from scratch.
      if (action === "recreate") {
        manager.cancel();
        managers.delete(key);

        const freshManager = getOrCreateManager(ctx);
        if (!freshManager) {
          return undefined;
        }
        manager = freshManager;
      }

      // Forward ALL new messages (not just the last one) to the buffer manager.
      const newMessages = messages.slice(newStartIndex);

      if (newMessages.length === 0) {
        return { messages: manager.getActiveMessages() };
      }

      let updatedMessages: AgentMessage[] | undefined;
      for (const msg of newMessages) {
        updatedMessages = await manager.onMessage(msg);
      }

      tracker.commit(key, messages.length);

      return { messages: updatedMessages! };
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        `Double-buffer context hook failed: ${errMessage}. ` +
          `Falling back to unmodified messages.`,
      );
      return undefined;
    }
  });
}
