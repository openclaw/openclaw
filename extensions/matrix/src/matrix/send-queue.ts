const SEND_GAP_MS = 150;

// Serialize sends per room to preserve Matrix delivery order.
const roomQueues = new Map<string, Promise<void>>();

export async function enqueueSend<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const previous = roomQueues.get(roomId) ?? Promise.resolve();

  const next = previous
    .catch(() => {})
    .then(async () => {
      await delay(SEND_GAP_MS);
      return await fn();
    });

  const queueMarker = next.then(
    () => {},
    () => {},
  );
  roomQueues.set(roomId, queueMarker);

  queueMarker.finally(() => {
    if (roomQueues.get(roomId) === queueMarker) {
      roomQueues.delete(roomId);
    }
  });

  return await next;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
