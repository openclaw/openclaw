type EventSink<T> = {
  push(event: T): void;
};

export function createDeferredEventBuffer<T>(sink: EventSink<T>) {
  let events: T[] = [];
  return {
    push(event: T): void {
      events.push(event);
    },
    flush(): void {
      for (const event of events) {
        sink.push(event);
      }
      events = [];
    },
    discard(): void {
      events = [];
    },
  };
}
