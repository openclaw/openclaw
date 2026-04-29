import type { GatewayEvent } from "./types.js";

type Listener<T> = (event: T) => void;

export class EventHub<T> {
  private closed = false;
  private readonly listeners = new Set<Listener<T>>();
  private readonly waiters = new Set<() => void>();

  publish(event: T): void {
    if (this.closed) {
      return;
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    for (const wake of this.waiters) {
      wake();
    }
    this.waiters.clear();
  }

  async *stream(filter?: (event: T) => boolean): AsyncIterable<T> {
    const queue: T[] = [];
    let wake: (() => void) | null = null;
    const listener = (event: T) => {
      if (!filter || filter(event)) {
        queue.push(event);
        wake?.();
        wake = null;
      }
    };

    this.listeners.add(listener);
    try {
      while (!this.closed) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          const wakeCurrent = () => {
            this.waiters.delete(wakeCurrent);
            resolve();
          };
          wake = wakeCurrent;
          this.waiters.add(wakeCurrent);
        });
      }
      while (queue.length > 0) {
        const next = queue.shift();
        if (next) {
          yield next;
        }
      }
    } finally {
      this.listeners.delete(listener);
      if (wake) {
        this.waiters.delete(wake);
      }
    }
  }
}

export function isGatewayEvent(value: unknown): value is GatewayEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { event?: unknown }).event === "string"
  );
}
