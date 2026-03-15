/**
 * Sliding window extension — caps conversation history to the most recent N user exchanges.
 *
 * An "exchange" is a user message plus the assistant response(s) that follow it.
 * System messages and injected context that precede the first retained user message
 * are preserved automatically (they live in the system prompt, not in the messages array).
 *
 * This only affects the in-memory context sent to the model; it does not rewrite
 * session history persisted on disk.
 */

import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";

export const DEFAULT_MAX_EXCHANGES = 20;

export interface SlidingWindowConfig {
  /** Maximum number of user exchanges to keep (default: 20). Set to 0 to disable. */
  maxExchanges?: number;
}

export interface SlidingWindowRuntime {
  maxExchanges: number;
}

const { set: setSlidingWindowRuntime, get: getSlidingWindowRuntime } =
  createSessionManagerRuntimeRegistry<SlidingWindowRuntime>();

export { setSlidingWindowRuntime };

export default function slidingWindowExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getSlidingWindowRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    const { maxExchanges } = runtime;
    if (maxExchanges <= 0) {
      return undefined;
    }

    const messages = event.messages;
    if (!messages || messages.length === 0) {
      return undefined;
    }

    // Find all user message indices.
    const userIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "user") {
        userIndices.push(i);
      }
    }

    if (userIndices.length <= maxExchanges) {
      return undefined;
    }

    // Keep from the Nth-from-last user message onward.
    const cutIndex = userIndices[userIndices.length - maxExchanges];
    const sliced = messages.slice(cutIndex);

    // Repair any orphaned tool results caused by the cut removing an assistant
    // tool_use message while keeping its toolResult.
    const repaired = sanitizeToolUseResultPairing(sliced as any) as typeof sliced;

    return { messages: repaired };
  });
}
