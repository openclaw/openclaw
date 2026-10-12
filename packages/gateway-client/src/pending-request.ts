import type { ErrorShape, ResponseFrame } from "@openclaw/gateway-protocol";
import {
  GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS,
  isGatewayRestartUnavailableError,
  isGatewaySuspendUnavailableError,
} from "@openclaw/gateway-protocol/restart-unavailable";
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  retainGatewayResponsePayload,
  type GatewayProtocolRequestOptions,
} from "./protocol-request.js";
import { resolveSafeTimeoutDelayMs } from "./timeouts.js";

export type GatewayProtocolRequestTiming = {
  id: string;
  method: string;
  ok: boolean;
  durationMs: number;
  startedAtMs: number;
  endedAtMs: number;
  errorCode?: string;
};

type GatewayRequestSender = {
  send: (data: string) => void;
};

type GatewayPendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  expectFinal: boolean;
  acceptedNotified: boolean;
  onAccepted?: (payload: unknown) => void;
  cleanup?: () => void;
  unbounded: boolean;
  method: string;
  startedAtMs: number;
  resend?: () => void;
  waitingForResume?: boolean;
};

type GatewayPendingRequestsOptions = {
  createRequestId: () => string;
  createRequestError?: (error: Partial<ErrorShape>) => GatewayProtocolRequestError;
  createRequestTimeoutError?: (method: string, timeoutMs: number, requestSent: boolean) => Error;
  createRequestAbortError?: (method: string) => Error;
  requestTimeoutMs?: number;
  nowMs: () => number;
  onTiming?: (timing: GatewayProtocolRequestTiming) => void;
  onCallbackError?: (label: string, error: unknown) => void;
};

/** Owns request deadlines, correlation, settlement, and generation-scoped IDs. */
export class GatewayPendingRequests {
  private pending = new Map<string, GatewayPendingRequest>();
  private requestSequence = 0;
  private bootstrapPause:
    | {
        timer?: ReturnType<typeof setTimeout>;
        probe?: { pending: GatewayPendingRequest; revision: number };
        retryAtMs: number;
        revision: number;
        announced: boolean;
      }
    | undefined;

  constructor(private readonly opts: GatewayPendingRequestsOptions) {}

  setSuspensionPhase(phase: unknown): void {
    if (phase === "accepting") {
      this.resumeBootstrapRequests();
    } else if (phase === "preparing" || phase === "draining" || phase === "prepared") {
      this.pauseBootstrapRequests(undefined, true);
    }
  }

  private pauseBootstrapRequests(
    retryAfterMs = GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS,
    announced = false,
  ): void {
    const nowMs = this.opts.nowMs();
    const delayMs = resolveSafeTimeoutDelayMs(
      Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS,
    );
    const pause = (this.bootstrapPause ??= { retryAtMs: nowMs, revision: 0, announced });
    pause.announced ||= announced;
    pause.revision += 1;
    pause.retryAtMs = Math.max(pause.retryAtMs, nowMs + delayMs);
    clearTimeout(pause.timer);
    pause.timer = undefined;
    // An announced drain ends through readiness or connection retirement, not a read probe.
    if (pause.announced) {
      return;
    }
    pause.timer = setTimeout(
      () => {
        // A rolled-back fence may not publish readiness. An expired empty
        // pause lets the next read probe without imposing another wait.
        pause.timer = undefined;
        this.drainBootstrapRequests();
      },
      resolveSafeTimeoutDelayMs(pause.retryAtMs - nowMs),
    );
    pause.timer.unref?.();
  }

  private resumeBootstrapRequests(): void {
    clearTimeout(this.bootstrapPause?.timer);
    this.bootstrapPause = undefined;
    this.drainBootstrapRequests();
  }

  private drainBootstrapRequests(): void {
    for (const pending of this.pending.values()) {
      if (pending.waitingForResume) {
        pending.resend?.();
      }
    }
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  get hasUnboundedPending(): boolean {
    for (const pending of this.pending.values()) {
      if (pending.unbounded) {
        return true;
      }
    }
    return false;
  }

  request<T>(
    sender: GatewayRequestSender,
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    let id: string;
    try {
      id = this.allocateRequestId();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const requestedTimeoutMs =
      options?.timeoutMs === null ? undefined : (options?.timeoutMs ?? this.opts.requestTimeoutMs);
    const timeoutMs =
      typeof requestedTimeoutMs === "number" && Number.isFinite(requestedTimeoutMs)
        ? resolveSafeTimeoutDelayMs(requestedTimeoutMs, { minMs: 0 })
        : undefined;
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let requestSent = false;
      const pending: GatewayPendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal: options?.expectFinal === true,
        acceptedNotified: false,
        onAccepted: options?.onAccepted,
        unbounded: timeoutMs === undefined,
        method,
        startedAtMs: this.opts.nowMs(),
      };
      const cleanup = () => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        options?.signal?.removeEventListener("abort", onAbort);
        if (this.bootstrapPause?.probe?.pending === pending) {
          this.bootstrapPause.probe = undefined;
          this.drainBootstrapRequests();
        }
      };
      const retire = (errorCode: string): boolean => {
        if (this.pending.get(id) !== pending) {
          return false;
        }
        this.pending.delete(id);
        cleanup();
        this.finishTiming(id, pending, false, errorCode);
        return true;
      };
      const onAbort = () => {
        if (!retire("CLIENT_ABORTED")) {
          return;
        }
        reject(
          this.opts.createRequestAbortError?.(method) ??
            new Error(`gateway request aborted for ${method}`),
        );
      };
      if (options?.signal?.aborted) {
        reject(
          this.opts.createRequestAbortError?.(method) ??
            new Error(`gateway request aborted for ${method}`),
        );
        return;
      }
      pending.cleanup = cleanup;
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (!retire("CLIENT_TIMEOUT")) {
            return;
          }
          reject(
            this.opts.createRequestTimeoutError?.(method, timeoutMs, requestSent) ??
              new GatewayProtocolRequestTimeoutError({ method, timeoutMs, requestSent }),
          );
        }, timeoutMs);
        timeout.unref?.();
      }
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, pending);
      try {
        const frame = JSON.stringify({ type: "req", id, method, params });
        const send = () => {
          if (
            this.pending.get(id) !== pending ||
            options?.signal?.aborted ||
            (pending.waitingForResume &&
              timeoutMs !== undefined &&
              this.opts.nowMs() - pending.startedAtMs >= timeoutMs)
          ) {
            return;
          }
          const pause = pending.resend ? this.bootstrapPause : undefined;
          if (pause && !pause.announced && !pause.timer && !pause.probe) {
            pause.probe = { pending, revision: pause.revision };
          }
          pending.waitingForResume = Boolean(
            pause && (pause.announced || pause.probe?.pending !== pending),
          );
          if (pending.waitingForResume) {
            return;
          }
          try {
            sender.send(frame);
            if (this.pending.get(id) !== pending) {
              return;
            }
            requestSent = true;
            this.invoke("sent", () => options?.onSent?.(id));
          } catch (error) {
            if (retire("CLIENT_SEND_ERROR")) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          }
        };
        // Writes retain their synchronous authority/send boundary and are never replayed.
        if (
          method === "agent.identity.get" ||
          method === "sessions.subscribe" ||
          method === "sessions.groups.list" ||
          method === "question.list" ||
          method === "sessions.list"
        ) {
          pending.resend = send;
        }
        send();
      } catch (error) {
        if (retire("CLIENT_SEND_ERROR")) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  handleResponse(frame: ResponseFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    const status = (frame.payload as { status?: unknown } | undefined)?.status;
    if (frame.ok && pending.expectFinal && status === "accepted") {
      if (!pending.acceptedNotified) {
        pending.acceptedNotified = true;
        this.invoke("accepted", () => pending.onAccepted?.(frame.payload));
      }
      return;
    }
    if (
      !frame.ok &&
      pending.resend &&
      !pending.acceptedNotified &&
      frame.error?.code === "UNAVAILABLE" &&
      frame.error.retryable === true &&
      (isGatewaySuspendUnavailableError(frame.error) ||
        isGatewayRestartUnavailableError(frame.error))
    ) {
      // The admission fence refused execution. Keep the original deadline and cancellation.
      if (this.bootstrapPause?.probe?.pending === pending) {
        this.bootstrapPause.probe = undefined;
      }
      this.pauseBootstrapRequests(
        isGatewayRestartUnavailableError(frame.error)
          ? Math.ceil(
              Math.max(GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS, frame.error.retryAfterMs ?? 0) *
                (1 + Math.random() * 0.2),
            )
          : frame.error.retryAfterMs,
      );
      pending.waitingForResume = true;
      return;
    }
    this.pending.delete(frame.id);
    if (
      frame.ok &&
      this.bootstrapPause?.probe?.pending === pending &&
      this.bootstrapPause.probe.revision === this.bootstrapPause.revision
    ) {
      this.resumeBootstrapRequests();
    }
    pending.cleanup?.();
    if (frame.ok) {
      this.finishTiming(frame.id, pending, true);
      pending.resolve(frame.payload);
      return;
    }
    this.finishTiming(frame.id, pending, false, frame.error?.code);
    const error =
      this.opts.createRequestError?.(frame.error ?? {}) ??
      new GatewayProtocolRequestError(frame.error ?? {});
    retainGatewayResponsePayload(error, frame.payload);
    pending.reject(error);
  }

  flush(error: Error): void {
    clearTimeout(this.bootstrapPause?.timer);
    this.bootstrapPause = undefined;
    const retired = this.pending;
    this.pending = new Map();
    // Timing observers can reconnect synchronously, so detach the entire old
    // generation and reset its sequence before running any caller-owned code.
    this.requestSequence = 0;
    for (const [id, pending] of retired) {
      pending.cleanup?.();
      this.finishTiming(id, pending, false, "CLIENT_CLOSED");
      pending.reject(error);
    }
  }

  private allocateRequestId(): string {
    this.requestSequence += 1;
    return `${this.requestSequence}:${this.opts.createRequestId()}`;
  }

  private finishTiming(
    id: string,
    pending: GatewayPendingRequest,
    ok: boolean,
    errorCode?: string,
  ): void {
    const endedAtMs = this.opts.nowMs();
    this.invoke("request timing", () =>
      this.opts.onTiming?.({
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
