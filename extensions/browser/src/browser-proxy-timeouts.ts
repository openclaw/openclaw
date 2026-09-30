import { MAX_TIMER_TIMEOUT_MS, resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 20_000;
const BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS = 5_000;

export function resolveBrowserProxyTimeoutMs(timeoutMs?: number): number {
  return resolveTimerTimeoutMs(timeoutMs, DEFAULT_BROWSER_PROXY_TIMEOUT_MS);
}

/** Leave time for browser diagnostics to cross the node and Gateway watchdogs. */
export function resolveBrowserProxyTimeouts(timeoutMs?: number) {
  const proxyTimeoutMs = Math.min(
    resolveBrowserProxyTimeoutMs(timeoutMs),
    MAX_TIMER_TIMEOUT_MS - 2 * BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS,
  );
  const nodeInvokeTimeoutMs = proxyTimeoutMs + BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS;
  const gatewayTimeoutMs = nodeInvokeTimeoutMs + BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS;
  return { proxyTimeoutMs, nodeInvokeTimeoutMs, gatewayTimeoutMs };
}
