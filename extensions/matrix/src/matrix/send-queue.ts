export const DEFAULT_SEND_GAP_MS = 150;

type MatrixSendQueueOptions = {
  gapMs?: number;
  delayFn?: (ms: number) => Promise<void>;
};

// Serialize sends per room to preserve Matrix delivery order.
const roomQueues = new Map<string, Promise<unknown>>();

export function enqueueSend<T>(
  roomId: string,
  fn: () => Promise<T>,
  options?: MatrixSendQueueOptions,
): Promise<T> {
  const gapMs = options?.gapMs ?? DEFAULT_SEND_GAP_MS;
  const delayFn = options?.delayFn ?? delay;
  const previous = roomQueues.get(roomId) ?? Promise.resolve();
  const next = previous.then(() => delayFn(gapMs)).then(() => fn());
  roomQueues.set(
    roomId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
