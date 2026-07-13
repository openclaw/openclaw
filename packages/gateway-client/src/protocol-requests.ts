import type { ResponseFrame } from "@openclaw/gateway-protocol";
import {
  GatewayProtocolRequestError,
  type GatewayProtocolClientOptions,
  type GatewayProtocolRequestOptions,
  type GatewayProtocolSocket,
} from "./protocol-client-types.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  expectFinal: boolean;
  acceptedNotified: boolean;
  onAccepted?: (payload: unknown) => void;
  cleanup?: () => void;
  unbounded: boolean;
  method: string;
  startedAtMs: number;
};

export class GatewayProtocolRequests<TPlan> {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: GatewayProtocolClientOptions<TPlan>) {}

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  get hasUnboundedPending(): boolean {
    return [...this.pending.values()].some((pending) => pending.unbounded);
  }

  request<T>(
    socket: GatewayProtocolSocket,
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    const id = this.opts.createRequestId();
    const frame = { type: "req", id, method, params };
    const timeoutMs =
      options?.timeoutMs === null ? undefined : (options?.timeoutMs ?? this.opts.requestTimeoutMs);
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const pending: Pending = {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal: options?.expectFinal === true,
        acceptedNotified: false,
        onAccepted: options?.onAccepted,
        unbounded: timeoutMs === undefined,
        method,
        startedAtMs: this.opts.nowMs?.() ?? Date.now(),
      };
      const onAbort = () => {
        this.pending.delete(id);
        if (timeout) {
          clearTimeout(timeout);
        }
        this.finishTiming(id, pending, false, "CLIENT_ABORTED");
        reject(
          this.opts.createRequestAbortError?.(method) ??
            new Error(`gateway request aborted for ${method}`),
        );
      };
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        options?.signal?.removeEventListener("abort", onAbort);
      };
      if (options?.signal?.aborted) {
        reject(
          this.opts.createRequestAbortError?.(method) ??
            new Error(`gateway request aborted for ${method}`),
        );
        return;
      }
      pending.cleanup = cleanup;
      if (timeoutMs !== undefined && timeoutMs >= 0) {
        timeout = setTimeout(() => {
          this.pending.delete(id);
          options?.signal?.removeEventListener("abort", onAbort);
          this.finishTiming(id, pending, false, "CLIENT_TIMEOUT");
          reject(
            this.opts.createRequestTimeoutError?.(method, timeoutMs) ??
              new Error(`gateway request timed out after ${timeoutMs}ms: ${method}`),
          );
        }, timeoutMs);
        timeout.unref?.();
      }
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, pending);
      try {
        socket.send(JSON.stringify(frame));
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        this.finishTiming(id, pending, false, "CLIENT_SEND_ERROR");
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  handleResponse(frame: ResponseFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    const status = (frame.payload as { status?: unknown } | undefined)?.status;
    if (pending.expectFinal && status === "accepted") {
      if (!pending.acceptedNotified) {
        pending.acceptedNotified = true;
        this.invoke("accepted", () => pending.onAccepted?.(frame.payload));
      }
      return;
    }
    this.pending.delete(frame.id);
    pending.cleanup?.();
    if (frame.ok) {
      this.finishTiming(frame.id, pending, true);
      pending.resolve(frame.payload);
      return;
    }
    this.finishTiming(frame.id, pending, false, frame.error?.code);
    pending.reject(
      this.opts.createRequestError?.(frame.error ?? {}) ??
        new GatewayProtocolRequestError(frame.error ?? {}),
    );
  }

  flush(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.finishTiming(id, pending, false, "CLIENT_CLOSED");
      pending.cleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private finishTiming(id: string, pending: Pending, ok: boolean, errorCode?: string): void {
    const endedAtMs = this.opts.nowMs?.() ?? Date.now();
    this.invoke("request timing", () =>
      this.opts.onRequestTiming?.({
        id,
        method: pending.method,
        ok,
        durationMs: Math.max(0, endedAtMs - pending.startedAtMs),
        startedAtMs: pending.startedAtMs,
        endedAtMs,
        errorCode,
      }),
    );
  }

  private invoke(label: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.opts.onCallbackError?.(label, error);
    }
  }
}
