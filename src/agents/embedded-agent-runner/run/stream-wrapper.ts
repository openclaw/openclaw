import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { createStreamIteratorWrapper } from "../../stream-iterator-wrapper.js";

/**
 * Wraps stream iteration so each object event can be observed without replacing
 * the stream object. Callers that hold provider-specific stream methods keep
 * those methods, while the async iterator gains observation side effects.
 */
export function wrapStreamObjectEvents(
  stream: MutableAssistantMessageEventStream,
  onEvent: (event: Record<string, unknown>) => void | Promise<void>,
): MutableAssistantMessageEventStream {
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return createStreamIteratorWrapper({
        iterator,
        next: async (streamIterator) => {
          const result = await streamIterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            await onEvent(result.value as Record<string, unknown>);
          }
          return result;
        },
      });
    };
  return stream;
}
