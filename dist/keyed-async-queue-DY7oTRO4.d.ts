//#region src/plugin-sdk/keyed-async-queue.d.ts
type KeyedAsyncQueueHooks = {
  onEnqueue?: () => void;
  onSettle?: () => void;
};
/** Serialize async work per key while allowing unrelated keys to run concurrently. */
declare function enqueueKeyedTask<T>(params: {
  tails: Map<string, Promise<void>>;
  key: string;
  task: () => Promise<T>;
  hooks?: KeyedAsyncQueueHooks;
}): Promise<T>;
declare class KeyedAsyncQueue {
  private readonly tails;
  getTailMapForTesting(): Map<string, Promise<void>>;
  enqueue<T>(key: string, task: () => Promise<T>, hooks?: KeyedAsyncQueueHooks): Promise<T>;
}
//#endregion
export { KeyedAsyncQueueHooks as n, enqueueKeyedTask as r, KeyedAsyncQueue as t };