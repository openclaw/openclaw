import { assertJsonRpcMessage, type JsonRpcMessage } from "../jsonrpc.js";
import { ListenerSet, type Unsubscribe } from "../subscriptions.js";

export class JsonlMessageBuffer {
  private buffer = "";
  private readonly messageListeners = new ListenerSet<[JsonRpcMessage]>();
  private readonly errorListeners = new ListenerSet<[Error]>();

  onMessage(listener: (message: JsonRpcMessage) => void): Unsubscribe {
    return this.messageListeners.subscribe(listener);
  }

  onError(listener: (error: Error) => void): Unsubscribe {
    return this.errorListeners.subscribe(listener);
  }

  push(chunk: Buffer | string): void {
    this.buffer += chunk.toString();

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.processLine(line);
    }
  }

  flush(): void {
    if (this.buffer.trim().length === 0) {
      this.buffer = "";
      return;
    }

    this.processLine(this.buffer);
    this.buffer = "";
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      this.messageListeners.emit(assertJsonRpcMessage(parsed));
    } catch (error) {
      this.errorListeners.emit(
        error instanceof Error ? error : new Error("Failed to parse JSONL app-server message"),
      );
    }
  }
}

export function encodeJsonlMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}
