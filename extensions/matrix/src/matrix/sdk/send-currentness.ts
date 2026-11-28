import { AsyncLocalStorage } from "node:async_hooks";

const sendCurrentness = new AsyncLocalStorage<{
  client: object;
  assertCurrent: () => void;
  abortSignal?: AbortSignal;
}>();

export function withMatrixSendCurrentness<T>(
  client: object,
  assertCurrent: () => void,
  run: () => T,
  abortSignal?: AbortSignal,
): T {
  assertCurrent();
  return sendCurrentness.run({ client, assertCurrent, abortSignal }, run);
}

export function captureMatrixSendContext(client: object) {
  const scope = sendCurrentness.getStore();
  return scope?.client === client ? scope : undefined;
}

export function captureMatrixSendCurrentness(client: object): (() => void) | undefined {
  return captureMatrixSendContext(client)?.assertCurrent;
}

/** Shared sync and crypto work belongs to the client generation, not a sender. */
export function withoutMatrixSendCurrentness<T>(run: () => T): T {
  return sendCurrentness.exit(run);
}
