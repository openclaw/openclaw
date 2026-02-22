import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export type SimplexWsResponse = {
  corrId?: string;
  resp?: {
    type: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type SimplexWsEvent = {
  type: string;
  [key: string]: unknown;
};

export type SimplexWsClientOptions = {
  url: string;
  connectTimeoutMs?: number;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
    debug?: (message: string) => void;
  };
};

type PendingCommand = {
  resolve: (value: SimplexWsResponse) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

export class SimplexWsClient {
  private readonly url: string;
  private readonly connectTimeoutMs: number;
  private readonly logger?: SimplexWsClientOptions["logger"];
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingCommand>();
  private eventHandlers = new Set<(event: SimplexWsEvent) => void>();

  constructor(options: SimplexWsClientOptions) {
    this.url = options.url;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.logger = options.logger;
  }

  onEvent(handler: (event: SimplexWsEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    const connectAttempt = new Promise<void>((resolve, reject) => {
      let settled = false;
      let opened = false;

      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      const ws = new WebSocket(this.url);
      this.ws = ws;

      const timeout = setTimeout(() => {
        const timeoutError = new Error(
          `SimpleX WS connect timeout after ${this.connectTimeoutMs}ms`,
        );
        this.handleSocketDisconnect(ws, timeoutError);
        ws.terminate();
        settleReject(timeoutError);
      }, this.connectTimeoutMs);

      ws.on("open", () => {
        opened = true;
        clearTimeout(timeout);
        this.logger?.info?.(`SimpleX WS connected: ${this.url}`);
        settleResolve();
      });

      ws.on("message", (data) => {
        this.handleMessage(data);
      });

      ws.on("close", (code, reason) => {
        clearTimeout(timeout);
        this.logger?.warn?.("SimpleX WS closed");
        const closeReason =
          typeof reason === "string"
            ? reason
            : Buffer.from(reason).toString("utf8") || "unknown reason";
        const closeError = new Error(`SimpleX WS closed (code=${code}, reason=${closeReason})`);
        this.handleSocketDisconnect(ws, closeError);
        if (!opened) {
          settleReject(closeError);
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger?.error?.(`SimpleX WS error: ${String(error)}`);
        this.handleSocketDisconnect(ws, error);
        settleReject(error);
      });
    });
    const inFlight = connectAttempt.finally(() => {
      if (this.connectPromise === inFlight) {
        this.connectPromise = null;
      }
    });
    this.connectPromise = inFlight;
    await inFlight;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("SimpleX WS failed to connect");
    }
  }

  async close(): Promise<void> {
    this.rejectAllPending(new Error("SimpleX WS closed"));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        this.ws?.once("close", () => resolve());
        this.ws?.close();
      });
    }
    this.ws = null;
  }

  async sendCommand(cmd: string, timeoutMs = 20_000): Promise<SimplexWsResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    const corrId = randomUUID();
    const payload = JSON.stringify({ corrId, cmd });
    return await new Promise<SimplexWsResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(corrId);
        reject(new Error(`SimpleX command timeout after ${timeoutMs}ms: ${cmd}`));
      }, timeoutMs);
      this.pending.set(corrId, { resolve, reject, timeout });
      this.ws?.send(payload, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pending.delete(corrId);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let text: string | null = null;
    if (typeof raw === "string") {
      text = raw;
    } else if (raw instanceof Buffer) {
      text = raw.toString("utf8");
    } else if (raw instanceof ArrayBuffer) {
      text = Buffer.from(raw).toString("utf8");
    } else if (Array.isArray(raw)) {
      text = Buffer.concat(raw).toString("utf8");
    }

    if (!text) {
      this.logger?.warn?.("SimpleX WS message had unsupported payload type");
      return;
    }
    let parsed: SimplexWsResponse;
    try {
      parsed = JSON.parse(text) as SimplexWsResponse;
    } catch (err) {
      this.logger?.warn?.(`SimpleX WS parse error: ${String(err)}`);
      return;
    }

    const corrId = parsed.corrId;
    if (corrId && this.pending.has(corrId)) {
      const pending = this.pending.get(corrId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(corrId);
        pending.resolve(parsed);
        return;
      }
    }

    const event = parsed.resp;
    if (!event || typeof event.type !== "string") {
      this.logger?.debug?.("SimpleX WS message missing event type");
      return;
    }

    for (const handler of this.eventHandlers) {
      handler(event as SimplexWsEvent);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [corrId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(corrId);
    }
  }

  private handleSocketDisconnect(ws: WebSocket, error: Error): void {
    // Ignore stale events from an older socket after reconnect.
    if (this.ws !== ws) {
      return;
    }
    this.ws = null;
    this.rejectAllPending(error);
  }
}
