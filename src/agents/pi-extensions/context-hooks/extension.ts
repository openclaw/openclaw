import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getContextHooksRuntime } from "./runtime.js";

export default function contextHooksExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextHooksRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    if (!runtime.hookRunner.hasHooks("before_context_send")) {
      return undefined;
    }

    const result = runtime.hookRunner.runBeforeContextSend(
      {
        messages: event.messages,
        modelId: runtime.modelId,
        provider: runtime.provider,
        contextWindowTokens: runtime.contextWindowTokens,
      },
      runtime.hookCtx,
    );

    if (!result?.messages) {
      return undefined;
    }

    return { messages: result.messages };
  });
}
