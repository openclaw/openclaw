import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Host-owned authority for a single explicitly acknowledged Responses request. */
export type ResponsesRequestLifecycle = {
  beforeDispatch(signal?: AbortSignal): Promise<void>;
  assertCurrent(): void;
  accepted(responseId: string, signal?: AbortSignal): Promise<void>;
  settle(): Promise<void>;
};

const lifecycleKey = Symbol("openclaw.responsesRequestLifecycle");

/** Private transport carrier: serialized options cannot mint host authority. */
export const responsesRequestLifecycle = {
  set(options: object, lifecycle: ResponsesRequestLifecycle): void {
    Object.defineProperty(options, lifecycleKey, { value: lifecycle, enumerable: true });
  },
  get(options: object | undefined): ResponsesRequestLifecycle | undefined {
    if (!options) {
      return undefined;
    }
    // SAFETY: Only set() can install this private symbol, with a typed host lifecycle.
    return Reflect.get(options, lifecycleKey) as ResponsesRequestLifecycle | undefined;
  },
};

/** A transport receipt must settle before model output can authorize later work. */
export function withResponsesRequestAcceptance<T>(
  events: AsyncIterable<T>,
  lifecycle: ResponsesRequestLifecycle | undefined,
  signal?: AbortSignal,
): AsyncIterable<T> {
  if (!lifecycle) {
    return events;
  }
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        if (isRecord(event) && event.type === "response.created") {
          const response = isRecord(event.response) ? event.response : undefined;
          if (typeof response?.id !== "string" || !response.id.trim()) {
            throw new Error("Provider continuation response has no identity");
          }
          signal?.throwIfAborted();
          lifecycle.assertCurrent();
          await lifecycle.accepted(response.id, signal);
          signal?.throwIfAborted();
          lifecycle.assertCurrent();
        }
        yield event;
      }
    },
  };
}
