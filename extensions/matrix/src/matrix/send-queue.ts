export const DEFAULT_SEND_GAP_MS = 150;

type MatrixSendQueueOptions = {
  gapMs?: number;
  delayFn?: (ms: number) => Promise<void>;
};

// Minimal keyed async queue: serializes concurrent tasks per key.
// Inlined to avoid openclaw/plugin-sdk/keyed-async-queue alias resolution
// failures in npm-installed (non-workspace) plugin environments.
class KeyedAsyncQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return current;
  }
}

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
