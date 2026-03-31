/**
 * SSE client for real-time event subscriptions from the gateway.
 */
import type { SSEEvent, SSEEventType } from "@mabos/shared";

type SSEHandler = (event: SSEEvent) => void;

export class GatewaySSEClient {
  private eventSource: EventSource | null = null;
  private handlers = new Map<string, Set<SSEHandler>>();
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (this.eventSource) {
      return;
    }
    this.eventSource = new EventSource(this.url);

    this.eventSource.addEventListener("message", (e) => {
      try {
        const event: SSEEvent = JSON.parse(e.data);
        this.emit(event.type, event);
        this.emit("*", event);
      } catch {
        // Ignore malformed events
      }
    });

    this.eventSource.addEventListener("error", () => {
      // EventSource auto-reconnects
    });
  }

  on(type: SSEEventType | "*", handler: SSEHandler): () => void {
    const handlers = this.handlers.get(type) ?? new Set();
    handlers.add(handler);
    this.handlers.set(type, handlers);
    return () => handlers.delete(handler);
  }

  private emit(type: string, event: SSEEvent): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }
}
