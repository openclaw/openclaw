import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AgentMessage } from "../../runtime/index.js";

/**
 * Synchronous transform for the LLM-boundary message array. Returning the same
 * array signals a true no-op so the wrapper can preserve the original context
 * object on hot stream paths.
 */
export type MessageTransform = (messages: AgentMessage[], model: unknown) => AgentMessage[];

/**
 * Applies a message transform immediately before invoking a stream function.
 * Only the `messages` field is replaced; all other context fields and stream
 * options are passed through unchanged.
 */
export function wrapStreamFnWithMessageTransform(
  streamFn: StreamFn,
  transform: MessageTransform,
): StreamFn {
  return (model, context, options) => {
    const messages = (context as unknown as { messages?: unknown })?.messages;
    if (!Array.isArray(messages)) {
      return streamFn(model, context, options);
    }

    const nextMessages = transform(messages as AgentMessage[], model);
    if (nextMessages === messages) {
      // Preserve object identity for callers that intentionally no-op the
      // transform, avoiding an unnecessary context clone on hot stream paths.
      return streamFn(model, context, options);
    }

    return streamFn(
      model,
      {
        ...(context as unknown as Record<string, unknown>),
        messages: nextMessages,
      } as typeof context,
      options,
    );
  };
}
