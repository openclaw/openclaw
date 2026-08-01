// OpenClaw SDK module implements event hub behavior.
import type { GatewayEvent } from "./types.js";

// Async event hub with bounded replay for SDK event streams.
type Listener<T> = (event: T) => void;

/** Replay settings for EventHub streams. */
type EventHubOptions = {
  replayLimit?: number;
};

/** Per-stream options for including replayed events. */
type EventStreamOptions = {
  replay?: boolean;
};

/** Small publish/subscribe hub used by SDK transports and normalized events. */
export class EventHub<T> {
  private readonly replayLimit: number;
  private readonly replayEvents: T[] = [];
  private closed = false;
  private closeError: unknown;
  private hasCloseError = false;
  private readonly listeners = new Set<Listener<T>>();
  private readonly waiters = new Set<() => void>();

  constructor(options: EventHubOptions = {}) {
    this.replayLimit = options.replayLimit ?? 0;
  }

  publish(event: T): void {
    if (this.closed) {
      return;
    }
    if (this.replayLimit > 0) {
      this.replayEvents.push(event);
      const overflow = this.replayEvents.length - this.replayLimit;
      if (overflow > 0) {
        this.replayEvents.splice(0, overflow);
      }
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  close(error?: unknown): void {
    const hasError = arguments.length > 0;
    if (hasError) {
      this.closeError = error;
      this.hasCloseError = true;
    }
    this.closed = true;
    this.replayEvents.length = 0;
    this.listeners.clear();
    for (const wake of this.waiters) {
      wake();
    }
    this.waiters.clear();
  }

  snapshot(filter?: (event: T) => boolean): T[] {
    return filter ? this.replayEvents.filter(filter) : [...this.replayEvents];
  }

  stream(filter?: (event: T) => boolean, options: EventStreamOptions = {}): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<T> => {
        const queue: T[] = options.replay ? this.snapshot(filter) : [];
        let stopped = false;
        let streamError: unknown;
        let hasStreamError = false;
        const pendingWakes = new Map<() => void, (event: T) => void>();
        const wakePending = (event?: { value: T }) => {
          const pending = pendingWakes.keys().next().value;
          if (!pending) {
            return false;
          }
          const deliver = pendingWakes.get(pending);
          pendingWakes.delete(pending);
          this.waiters.delete(pending);
          if (event) {
            deliver?.(event.value);
          }
          pending();
          return true;
        };
        const wakeAllPending = () => {
          for (const pending of pendingWakes.keys()) {
            pendingWakes.delete(pending);
            this.waiters.delete(pending);
            pending();
          }
        };
        const listener = (event: T) => {
          let matches: boolean;
          try {
            matches = !filter || filter(event);
          } catch (error) {
            // A broken subscriber owns its failure; never let its predicate
            // terminate the shared pump or any sibling event stream.
            streamError = error;
            hasStreamError = true;
            cleanup();
            return;
          }
          if (matches) {
            // Reserve the event for its oldest waiting next() before its
            // microtask resumes; later readers cannot steal queued work.
            if (!wakePending({ value: event })) {
              queue.push(event);
            }
          }
        };
        const cleanup = () => {
          if (stopped) {
            return;
          }
          stopped = true;
          this.listeners.delete(listener);
          // Async iterators may have several next() calls in flight; release
          // every owner on return, local failure, or shared-hub shutdown.
          wakeAllPending();
        };

        this.listeners.add(listener);

        return {
          next: async (): Promise<IteratorResult<T>> => {
            while (true) {
              if (stopped) {
                break;
              }
              if (queue.length > 0) {
                return { done: false, value: queue.shift() as T };
              }
              if (this.closed) {
                break;
              }
              let reservedEvent: { value: T } | undefined;
              await new Promise<void>((resolve) => {
                const wakeCurrent = () => {
                  pendingWakes.delete(wakeCurrent);
                  this.waiters.delete(wakeCurrent);
                  resolve();
                };
                pendingWakes.set(wakeCurrent, (event) => {
                  reservedEvent = { value: event };
                });
                this.waiters.add(wakeCurrent);
              });
              if (reservedEvent) {
                return { done: false, value: reservedEvent.value };
              }
            }
            cleanup();
            if (hasStreamError) {
              throw streamError;
            }
            if (this.hasCloseError) {
              throw this.closeError;
            }
            return { done: true, value: undefined as never };
          },
          return: async (): Promise<IteratorResult<T>> => {
            cleanup();
            return { done: true, value: undefined as never };
          },
        };
      },
    };
  }
}

export function isGatewayEvent(value: unknown): value is GatewayEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { event?: unknown }).event === "string"
  );
}
