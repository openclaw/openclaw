import type { GatewayProtocolRequestOptions } from "./protocol-request.js";

/** Preserve public client request defaults while keeping options request-scoped. */
export function resolveGatewayClientRequestOptions(
  opts: GatewayProtocolRequestOptions | undefined,
  defaultTimeoutMs: number,
): GatewayProtocolRequestOptions {
  const expectFinal = opts?.expectFinal === true;
  const timeoutMs =
    opts?.timeoutMs === null
      ? null
      : typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
        ? opts.timeoutMs
        : expectFinal
          ? null
          : defaultTimeoutMs;
  return {
    expectFinal,
    timeoutMs,
    signal: opts?.signal,
    onSent: opts?.onSent,
    onAccepted: opts?.onAccepted,
    ...(opts?.traceparent !== undefined ? { traceparent: opts.traceparent } : {}),
  };
}
