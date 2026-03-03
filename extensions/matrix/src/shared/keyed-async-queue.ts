export type KeyedAsyncQueueHooks = {
  onEnqueue?: () => void;
  onSettle?: () => void;
};

export class KeyedAsyncQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue<T>(key: string, task: () => Promise<T>, hooks?: KeyedAsyncQueueHooks): Promise<T> {
    hooks?.onEnqueue?.();
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        hooks?.onSettle?.();
      });

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
