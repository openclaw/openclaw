type SubscribeEmbeddedPiSession =
  typeof import("./pi-embedded-subscribe.js").subscribeEmbeddedPiSession;
type PiSession = Parameters<SubscribeEmbeddedPiSession>[0]["session"];

export function createStubSessionHarness(): {
  session: PiSession;
  emit: (evt: unknown) => void;
} {
  let handler: ((evt: unknown) => void) | undefined;
  const session = {
    subscribe: (fn: (evt: unknown) => void) => {
      handler = fn;
      return () => {};
    },
  } as unknown as PiSession;

  return { session, emit: (evt: unknown) => handler?.(evt) };
}

export function extractAgentEventPayloads(calls: Array<unknown[]>): Array<Record<string, unknown>> {
  return calls
    .map((call) => {
      const first = call?.[0] as { data?: unknown } | undefined;
      const data = first?.data;
      return data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
    })
    .filter((value): value is Record<string, unknown> => Boolean(value));
}
