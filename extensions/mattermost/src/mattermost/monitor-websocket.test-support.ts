import { EventEmitter } from "node:events";

export class FakeWebSocket extends EventEmitter<{
  open: [];
  message: [Buffer];
  pong: [Buffer];
  close: [number, Buffer];
  error: [unknown];
}> {
  send(_data: string): void {}
  ping(): void {}
  close(): void {}
  terminate(): void {
    this.emit("close", 1000, Buffer.alloc(0));
  }
  async emitMessage(payload: unknown): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(payload), "utf8");
    await Promise.all(
      this.listeners("message").map((listener) => Promise.resolve(listener(buffer))),
    );
  }
}
