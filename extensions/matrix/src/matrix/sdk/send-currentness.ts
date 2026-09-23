import { AsyncLocalStorage } from "node:async_hooks";

const sendCurrentness = new AsyncLocalStorage<{
  client: object;
  assertCurrent: () => void;
}>();

export function withMatrixSendCurrentness<T>(
  client: object,
  assertCurrent: () => void,
  run: () => T,
): T {
  assertCurrent();
  return sendCurrentness.run({ client, assertCurrent }, run);
}

export function captureMatrixSendCurrentness(client: object): (() => void) | undefined {
  const scope = sendCurrentness.getStore();
  return scope?.client === client ? scope.assertCurrent : undefined;
}

/** Shared sync and crypto work belongs to the client generation, not a sender. */
export function withoutMatrixSendCurrentness<T>(run: () => T): T {
  return sendCurrentness.exit(run);
}
