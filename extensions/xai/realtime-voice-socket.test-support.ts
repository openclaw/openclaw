// Shared xAI realtime test doubles: a fake WebSocket and provider auth mocks.
import { vi } from "vitest";

type Listener = (...args: unknown[]) => void;

export class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly listeners = new Map<string, Listener[]>();
  readyState = 0;
  sent: string[] = [];
  closed = false;
  terminated = false;
  deferClose = false;
  pendingClose: { code: number; reason: Buffer } | undefined;
  args: unknown[];

  constructor(...args: unknown[]) {
    this.args = args;
    FakeWebSocket.instances.push(this);
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
    const closeEvent = { code: code ?? 1000, reason: Buffer.from(reason ?? "") };
    if (this.deferClose) {
      this.pendingClose = closeEvent;
      return;
    }
    this.emit("close", closeEvent.code, closeEvent.reason);
  }

  terminate(): void {
    this.terminated = true;
    this.close(1006, "terminated");
  }

  flushClose(): void {
    const closeEvent = this.pendingClose;
    this.pendingClose = undefined;
    if (closeEvent) {
      this.emit("close", closeEvent.code, closeEvent.reason);
    }
  }
}

export const isProviderAuthProfileConfiguredMock = vi.fn((_params: { agentDir?: string }) => false);

export const resolveApiKeyForProviderMock = vi.fn(
  async (_params: { agentDir?: string }): Promise<{ apiKey: string | undefined }> => ({
    apiKey: undefined,
  }),
);
