import { EventEmitter } from "node:events";
import { vi } from "vitest";

export class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static onCreate: ((socket: FakeWebSocket) => void) | undefined;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  terminated = false;
  args: unknown[];

  readonly url?: string;
  readonly options?: { headers?: Record<string, string>; maxPayload?: number };

  constructor(...args: [url?: string, options?: FakeWebSocket["options"]]) {
    super();
    this.args = args;
    [this.url, this.options] = args;
    FakeWebSocket.instances.push(this);
    FakeWebSocket.onCreate?.(this);
  }

  override emit(event: string, ...args: unknown[]): boolean {
    // Preserve the fixture's ignored unobserved errors while sharing listener/once semantics.
    if (event === "error" && this.listenerCount(event) === 0) {
      return false;
    }
    return super.emit(event, ...args);
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

export const isProviderAuthProfileConfiguredAsyncMock = vi.fn(
  async (_params: { agentDir?: string }) => false,
);

export const resolveApiKeyForProviderMock = vi.fn(
  async (_params: { agentDir?: string }): Promise<{ apiKey: string | undefined }> => ({
    apiKey: undefined,
  }),
);
