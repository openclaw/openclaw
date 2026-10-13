// Shared Inworld realtime test doubles: a fake WebSocket standing in for ./ws-runtime.js.

type Listener = (...args: unknown[]) => void;

export class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  private static creationWaiters: Array<{
    index: number;
    resolve: (socket: FakeWebSocket) => void;
  }> = [];

  readonly listeners = new Map<string, Listener[]>();
  readyState = 0;
  sent: string[] = [];
  closed = false;
  terminated = false;
  args: unknown[];

  constructor(...args: unknown[]) {
    this.args = args;
    FakeWebSocket.instances.push(this);
    FakeWebSocket.settleCreationWaiters();
  }

  /** Resolves with the socket at `index` once the fixture constructs it; no timers or polling. */
  static waitForInstance(index = 0): Promise<FakeWebSocket> {
    const existing = FakeWebSocket.instances[index];
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      FakeWebSocket.creationWaiters.push({ index, resolve });
    });
  }

  private static settleCreationWaiters(): void {
    const pending = FakeWebSocket.creationWaiters;
    FakeWebSocket.creationWaiters = [];
    for (const waiter of pending) {
      const socket = FakeWebSocket.instances[waiter.index];
      if (socket) {
        waiter.resolve(socket);
      } else {
        FakeWebSocket.creationWaiters.push(waiter);
      }
    }
  }

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  emitServer(event: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }

  terminate(): void {
    this.terminated = true;
    this.close(1006, "terminated");
  }
}
