/**
 * Browser-local SDK bridge for gateway, plugin runtime, and timeout helpers.
 */
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clampTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

export {
  ensureGatewayStartupAuth,
  ErrorCodes,
  errorShape,
  isNodeCommandAllowed,
  respondUnavailableOnNodeInvokeError,
  resolveGatewayAuth,
  resolveNodeCommandAllowlist,
  safeParseJson,
} from "openclaw/plugin-sdk/gateway-runtime";
export type { GatewayRequestHandlers, NodeSession } from "openclaw/plugin-sdk/gateway-runtime";
export type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
export {
  startLazyPluginServiceModule,
  type LazyPluginServiceHandle,
} from "openclaw/plugin-sdk/plugin-runtime";

/** Runs async work with an optional aborting timeout signal. */
export async function withTimeout<T>(
  work: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs?: number,
  label?: string,
): Promise<T> {
  const resolved = clampTimerTimeoutMs(timeoutMs);
  if (!resolved) {
    return await work(undefined);
  }

  const controller = new AbortController();
  const error = new Error(`${label ?? "request"} timed out`);
  const timeout = createDeferred<never>();
  const timer = setTimeout(() => {
    // Timeout wins even when work resolves from its abort listener.
    timeout.reject(error);
    controller.abort(error);
  }, resolved);
  timer.unref?.();

  try {
    return await Promise.race([work(controller.signal), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}
