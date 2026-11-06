export type ControlUiRpcRecord = {
  direction: "request" | "response" | "event";
  socketId: number;
  phase: string;
  atMs: number;
  id?: string;
  method?: string;
  event?: string;
  seq?: number;
  ok?: boolean;
  params?: unknown;
  frameBytes: number;
  payloadBytes: number;
  /** Serialized field values, excluding their keys and enclosing punctuation. */
  payloadFieldBytes: Record<string, number>;
  /** Top-level payload arrays; "$" denotes an array payload itself. */
  payloadArrayCounts: Record<string, number>;
  parseMs: number;
  parseCalls: number;
  applyMs: number;
  listenerCalls: number;
  /** End of synchronous listeners to the next MessageChannel task, not CPU time. */
  microtaskSettleMs?: number;
  requestAtMs?: number;
  requestPhase?: string;
  rttMs?: number;
  sendFailed?: boolean;
};

declare global {
  interface Window {
    openclawRpcPayloads?: ControlUiRpcRecord[];
    openclawRpcPhase?: string;
  }
}

/**
 * Synthetic-only browser instrumentation, serialized with page.addInitScript.
 * Metadata needs its own untimed parse/serialization, so instrument both sides of
 * a comparison alike. Only the application's parse of the delivered frame counts
 * toward parseMs. applyMs covers synchronous message listeners, not async work,
 * rendering or paint. The settle marker includes microtasks and scheduling delay;
 * other queued work can extend it. Binary frames and onmessage handlers are not
 * timed: the Control UI protocol uses text frames and addEventListener.
 */
export function installControlUiRpcObserver() {
  if (window.openclawRpcPayloads) {
    return;
  }
  const records: ControlUiRpcRecord[] = [];
  window.openclawRpcPayloads = records;
  window.openclawRpcPhase ??= "cold-boot";
  const OriginalWebSocket = window.WebSocket;
  const originalParse = JSON.parse;
  const encoder = new TextEncoder();
  let nextSocketId = 0;
  type ActiveFrame = { source: string; record: ControlUiRpcRecord };
  let activeFrame: ActiveFrame | undefined;
  type Delivery = { record: ControlUiRpcRecord; completedAt: number; queued: boolean };
  const deliveries = new WeakMap<Event, Delivery>();
  const settlements: Delivery[] = [];
  const channel = new MessageChannel();
  channel.port1.addEventListener("message", () => {
    const delivery = settlements.shift();
    if (delivery) {
      delivery.record.microtaskSettleMs = performance.now() - delivery.completedAt;
    }
  });
  channel.port1.start();

  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const bytes = (value: unknown) => {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : encoder.encode(serialized).byteLength;
  };
  const payloadShape = (payload: unknown) => {
    const payloadFieldBytes: Record<string, number> = {};
    const payloadArrayCounts: Record<string, number> = {};
    if (Array.isArray(payload)) {
      payloadArrayCounts.$ = payload.length;
    } else if (object(payload)) {
      for (const [key, value] of Object.entries(payload)) {
        payloadFieldBytes[key] = bytes(value);
        if (Array.isArray(value)) {
          payloadArrayCounts[key] = value.length;
        }
      }
    }
    return { payloadBytes: bytes(payload), payloadFieldBytes, payloadArrayCounts };
  };
  const readFrame = (source: string): Record<string, unknown> | undefined => {
    try {
      const value: unknown = originalParse(source);
      return object(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  JSON.parse = (source, reviver) => {
    const active = activeFrame?.source === source ? activeFrame : undefined;
    if (!active) {
      return originalParse(source, reviver);
    }
    const startedAt = performance.now();
    try {
      return originalParse(source, reviver);
    } finally {
      active.record.parseMs += performance.now() - startedAt;
      active.record.parseCalls++;
    }
  };

  type SocketListener = NonNullable<Parameters<WebSocket["addEventListener"]>[1]>;
  type Registration = { listener: EventListener; forget(): void };
  window.WebSocket = class extends OriginalWebSocket {
    private readonly socketId = ++nextSocketId;
    private readonly requests = new Map<string, ControlUiRpcRecord>();
    private readonly listeners = new WeakMap<SocketListener, Map<boolean, Registration>>();

    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      // Registered first, and directly on the native owner, outside the timers.
      super.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (typeof event.data !== "string") {
          return;
        }
        const atMs = performance.now();
        const frame = readFrame(event.data);
        if (!frame || (frame.type !== "res" && frame.type !== "event")) {
          return;
        }
        const id = typeof frame.id === "string" ? frame.id : undefined;
        const request = id === undefined ? undefined : this.requests.get(id);
        const record: ControlUiRpcRecord = {
          direction: frame.type === "res" ? "response" : "event",
          socketId: this.socketId,
          phase: window.openclawRpcPhase ?? "cold-boot",
          atMs,
          id,
          method: request?.method,
          event: typeof frame.event === "string" ? frame.event : undefined,
          seq: typeof frame.seq === "number" ? frame.seq : undefined,
          ok: typeof frame.ok === "boolean" ? frame.ok : undefined,
          frameBytes: encoder.encode(event.data).byteLength,
          ...payloadShape(Object.hasOwn(frame, "payload") ? frame.payload : frame.error),
          parseMs: 0,
          parseCalls: 0,
          applyMs: 0,
          listenerCalls: 0,
          requestAtMs: request?.atMs,
          requestPhase: request?.phase,
          rttMs: request === undefined ? undefined : atMs - request.atMs,
        };
        if (id !== undefined && frame.type === "res") {
          this.requests.delete(id);
        }
        records.push(record);
        deliveries.set(event, { record, completedAt: 0, queued: false });
      });
    }

    override send(data: Parameters<WebSocket["send"]>[0]): void {
      const frame = typeof data === "string" ? readFrame(data) : undefined;
      if (!frame || frame.type !== "req" || typeof data !== "string") {
        super.send(data);
        return;
      }
      const record: ControlUiRpcRecord = {
        direction: "request",
        socketId: this.socketId,
        phase: window.openclawRpcPhase ?? "cold-boot",
        atMs: performance.now(),
        id: typeof frame.id === "string" ? frame.id : undefined,
        method: typeof frame.method === "string" ? frame.method : undefined,
        // Never retain authentication material, even in a synthetic capture.
        params: frame.method === "connect" ? "[redacted]" : frame.params,
        frameBytes: encoder.encode(data).byteLength,
        ...payloadShape(frame.method === "connect" ? undefined : frame.params),
        parseMs: 0,
        parseCalls: 0,
        applyMs: 0,
        listenerCalls: 0,
      };
      records.push(record);
      if (record.id !== undefined) {
        this.requests.set(record.id, record);
      }
      try {
        // Keep outgoing census work out of the client-observed round trip.
        record.atMs = performance.now();
        super.send(data);
      } catch (error) {
        record.sendFailed = true;
        if (record.id !== undefined) {
          this.requests.delete(record.id);
        }
        throw error;
      }
    }

    override addEventListener<K extends keyof WebSocketEventMap>(
      type: K,
      listener: (this: WebSocket, event: WebSocketEventMap[K]) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void;
    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void;
    override addEventListener(
      type: string,
      listener: SocketListener | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (listener === null) {
        return;
      }
      if (type !== "message") {
        super.addEventListener(type, listener, options);
        return;
      }
      if (typeof options === "object" && options.signal?.aborted) {
        return;
      }
      const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
      let registrations = this.listeners.get(listener);
      if (!registrations) {
        registrations = new Map();
        this.listeners.set(listener, registrations);
      }
      let registration = registrations.get(capture);
      if (!registration) {
        const signal = typeof options === "object" ? options.signal : undefined;
        const once = typeof options === "object" && options.once;
        const forget = () => {
          registrations.delete(capture);
          signal?.removeEventListener("abort", forget);
        };
        const wrapped: EventListener = (event) => {
          if (once) {
            forget();
          }
          const delivery = deliveries.get(event);
          const previous = activeFrame;
          activeFrame =
            delivery && event instanceof MessageEvent && typeof event.data === "string"
              ? { source: event.data, record: delivery.record }
              : undefined;
          const parsedBefore = delivery?.record.parseMs ?? 0;
          const startedAt = performance.now();
          try {
            if (typeof listener === "function") {
              Reflect.apply(listener, this, [event]);
            } else {
              listener.handleEvent(event);
            }
          } finally {
            const endedAt = performance.now();
            activeFrame = previous;
            if (delivery) {
              delivery.record.applyMs += Math.max(
                0,
                endedAt - startedAt - (delivery.record.parseMs - parsedBefore),
              );
              delivery.record.listenerCalls++;
              delivery.completedAt = endedAt;
              if (!delivery.queued) {
                delivery.queued = true;
                settlements.push(delivery);
                channel.port2.postMessage(null);
              }
            }
          }
        };
        registration = { listener: wrapped, forget };
        registrations.set(capture, registration);
        signal?.addEventListener("abort", forget, { once: true });
      }
      super.addEventListener(type, registration.listener, options);
    }

    override removeEventListener<K extends keyof WebSocketEventMap>(
      type: K,
      listener: (this: WebSocket, event: WebSocketEventMap[K]) => unknown,
      options?: boolean | EventListenerOptions,
    ): void;
    override removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void;
    override removeEventListener(
      type: string,
      listener: SocketListener | null,
      options?: boolean | EventListenerOptions,
    ): void {
      if (listener === null) {
        return;
      }
      const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
      const registration =
        type === "message" ? this.listeners.get(listener)?.get(capture) : undefined;
      if (registration) {
        registration.forget();
      }
      super.removeEventListener(type, registration?.listener ?? listener, options);
    }
  };
}
