import { streamSimple } from "@mariozechner/pi-ai";

type SimpleStream = ReturnType<typeof streamSimple>;

export function wrapStreamObjectEvents(
  stream: SimpleStream,
  onEvent: (event: Record<string, unknown>) => void | Promise<void>,
): SimpleStream {
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            await onEvent(result.value as Record<string, unknown>);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };
  return stream;
}
