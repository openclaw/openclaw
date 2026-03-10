import { KeyedAsyncQueue } from "openclaw/plugin-sdk";

export const DEFAULT_SEND_GAP_MS = 150;

type MatrixSendQueueOptions = {
  gapMs?: number;
  delayFn?: (ms: number) => Promise<void>;
};

// Serialize sends per room to preserve Matrix delivery order.
const roomQueues = new KeyedAsyncQueue();

export function enqueueSend<T>(
  roomId: string,
  fn: () => Promise<T>,
  options?: MatrixSendQueueOptions,
): Promise<T> {
  const gapMs = options?.gapMs ?? DEFAULT_SEND_GAP_MS;
  const delayFn = options?.delayFn ?? delay;
  return roomQueues.enqueue(roomId, async () => {
    await delayFn(gapMs);
    return await fn();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
