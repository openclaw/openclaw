import type { Api, Model } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("split-model-routing");

/**
 * Detects whether the current LLM call is a tool-continuation turn by
 * inspecting the last message in the conversation context. When the most
 * recent message has role "tool" or "toolResult", the session is re-prompting
 * the LLM after executing one or more tool calls.
 */
function isToolContinuationTurn(context: unknown): boolean {
  const ctx = context as { messages?: unknown } | undefined;
  const messages = ctx?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }
  const lastMessage = messages[messages.length - 1] as AgentMessage | undefined;
  if (!lastMessage) {
    return false;
  }
  const role = (lastMessage as { role?: string }).role;
  return role === "tool" || role === "toolResult";
}

/**
 * Wraps a StreamFn to route tool-continuation turns to a different model.
 *
 * On chat turns (user prompt → assistant response), the primary model is used.
 * On tool-continuation turns (tool result → assistant re-prompt), the tool model
 * is substituted so that a capable API model handles tool calls while the primary
 * (potentially local/cheap) model handles conversational turns.
 */
export function wrapStreamFnWithSplitModelRouting(params: {
  innerStreamFn: StreamFn;
  toolModel: Model<Api>;
  primaryProvider: string;
  toolProvider: string;
}): StreamFn {
  const { innerStreamFn, toolModel, primaryProvider, toolProvider } = params;
  let lastRouteWasTool = false;

  const wrappedStreamFn: StreamFn = (callModel, context, options) => {
    if (isToolContinuationTurn(context)) {
      if (!lastRouteWasTool) {
        log.info(
          `split-model routing: switching to tool model ${toolProvider}/${toolModel.id} for tool-continuation turn`,
        );
      }
      lastRouteWasTool = true;
      return innerStreamFn(toolModel, context, options);
    }

    if (lastRouteWasTool) {
      log.info(
        `split-model routing: returning to primary model ${primaryProvider}/${callModel.id} for chat turn`,
      );
    }
    lastRouteWasTool = false;
    return innerStreamFn(callModel, context, options);
  };

  return wrappedStreamFn;
}
