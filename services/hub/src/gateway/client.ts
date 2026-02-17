import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export type GatewayReqFrame = { type: "req"; id: string; method: string; params?: unknown };
export type GatewayResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};
export type GatewayFrame =
  | GatewayReqFrame
  | GatewayResFrame
  | { type: string; [key: string]: unknown };

function toText(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  return Buffer.from(data as Buffer).toString("utf8");
}

export function createGatewayWsClient(params: {
  url: string;
  handshakeTimeoutMs?: number;
  openTimeoutMs?: number;
}) {
  const ws = new WebSocket(params.url, { handshakeTimeout: params.handshakeTimeoutMs ?? 8000 });
  const pending = new Map<
    string,
    {
      resolve: (res: GatewayResFrame) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  type EventHandler = {
    resolve: (frame: GatewayFrame) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  };
  const eventWaiters = new Map<string, EventHandler>();

  const request = (method: string, paramsObj?: unknown, timeoutMs = 12_000) =>
    new Promise<GatewayResFrame>((resolve, reject) => {
      const id = randomUUID();
      const frame: GatewayReqFrame = { type: "req", id, method, params: paramsObj };
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify(frame));
    });

  const waitOpen = () =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("ws open timeout")),
        params.openTimeoutMs ?? 8000,
      );
      ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

  const waitForEvent = (eventName: string, timeoutMs = 8000) =>
    new Promise<GatewayFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        eventWaiters.delete(eventName);
        reject(new Error(`timeout waiting for event: ${eventName}`));
      }, timeoutMs);
      eventWaiters.set(eventName, { resolve, reject, timeout });
    });

  ws.on("message", (data) => {
    let frame: GatewayFrame | null = null;
    try {
      frame = JSON.parse(toText(data)) as GatewayFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object" || !("type" in frame)) {
      return;
    }
    if (frame.type === "res") {
      const res = frame as GatewayResFrame;
      const waiter = pending.get(res.id);
      if (waiter) {
        pending.delete(res.id);
        clearTimeout(waiter.timeout);
        waiter.resolve(res);
      }
    } else if (frame.type === "event") {
      const eventName = (frame as { event?: string }).event;
      if (eventName) {
        const waiter = eventWaiters.get(eventName);
        if (waiter) {
          eventWaiters.delete(eventName);
          clearTimeout(waiter.timeout);
          waiter.resolve(frame);
        }
      }
    }
  });

  const close = () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
    }
    for (const waiter of eventWaiters.values()) {
      clearTimeout(waiter.timeout);
    }
    pending.clear();
    eventWaiters.clear();
    ws.close();
  };

  return { ws, request, waitOpen, waitForEvent, close };
}
