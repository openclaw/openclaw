import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
const DEFAULT_SEND_GAP_MS = 150;
const roomQueues = new KeyedAsyncQueue();
function enqueueSend(roomId, fn, options) {
  const gapMs = options?.gapMs ?? DEFAULT_SEND_GAP_MS;
  const delayFn = options?.delayFn ?? delay;
  return roomQueues.enqueue(roomId, async () => {
    await delayFn(gapMs);
    return await fn();
  });
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export {
  DEFAULT_SEND_GAP_MS,
  enqueueSend
};
