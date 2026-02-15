import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { applyContextDecay } from "./decay.js";
import { getContextDecayRuntime } from "./runtime.js";

/**
 * Pi extension that applies graduated context decay before each LLM call.
 * Hooks into the SDK "context" event to strip thinking blocks, apply
 * pre-computed tool-result summaries, strip aged tool results, and
 * enforce a hard message cap.
 */
export default function contextDecayExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextDecayRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    const next = applyContextDecay({
      messages: event.messages,
      config: runtime.config,
      summaryStore: runtime.summaryStore,
      groupSummaryStore: runtime.groupSummaryStore,
    });

    if (next === event.messages) {
      return undefined;
    }

    return { messages: next };
  });
}
