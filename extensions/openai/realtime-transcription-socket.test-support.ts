type Listener = (...args: unknown[]) => void;

export function createTranscriptionMockWebSocket() {
  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];
    static onCreated: ((socket: MockWebSocket) => void) | undefined;

    readonly listeners = new Map<string, Listener[]>();
    readonly headers?: Record<string, string>;
    readonly url?: string;
    readyState = 0;
    sent: string[] = [];
    closed = false;

    constructor(url?: string, options?: { headers?: Record<string, string> }) {
      this.url = url;
      this.headers = options?.headers;
      MockWebSocket.instances.push(this);
      MockWebSocket.onCreated?.(this);
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

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(code?: number, reason?: string): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }

    terminate(): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  return MockWebSocket;
}
