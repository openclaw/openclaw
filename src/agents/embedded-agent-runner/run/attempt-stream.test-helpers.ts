export type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

export function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

export async function collectStreamEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  // Drain streams to inspect generated tool-call events after wrapper mutation.
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
