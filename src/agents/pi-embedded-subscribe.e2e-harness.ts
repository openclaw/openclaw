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
