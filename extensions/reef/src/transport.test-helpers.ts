export class ControlledSocket {
  closeCalls = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  private closed = false;

  constructor(private readonly closeImmediately = true) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closeCalls++;
    if (this.closed || !this.closeImmediately) {
      return;
    }
    this.closed = true;
    this.emit("close");
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
