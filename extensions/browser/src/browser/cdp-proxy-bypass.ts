/**
 * Proxy bypass for CDP (Chrome DevTools Protocol) localhost connections.
 *
 * When HTTP_PROXY / HTTPS_PROXY / ALL_PROXY environment variables are set,
 * CDP connections to localhost/127.0.0.1 can be incorrectly routed through
 * the proxy, causing browser control to fail.
 *
 * @see https://github.com/nicepkg/openclaw/issues/31219
 */
import http from "node:http";
import https from "node:https";
import { hasProxyEnvConfigured } from "openclaw/plugin-sdk/security-runtime";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { registerManagedProxyBrowserCdpBypass } from "openclaw/plugin-sdk/ssrf-runtime-internal";

/** HTTP agent that never uses a proxy — for localhost CDP connections. */
const directHttpAgent = new http.Agent();
const directHttpsAgent = new https.Agent();

/**
 * Returns a plain (non-proxy) agent for WebSocket or HTTP connections
 * when the target is a loopback address. Returns `undefined` otherwise
 * so callers fall through to their default behaviour.
 */
export function getDirectAgentForCdp(url: string): http.Agent | https.Agent | undefined {
  const parsed = URL.parse(url);
  if (parsed && isLoopbackHost(parsed.hostname)) {
    return parsed.protocol === "https:" || parsed.protocol === "wss:"
      ? directHttpsAgent
      : directHttpAgent;
  }
  return undefined;
}

const LOOPBACK_ENTRIES = "localhost,127.0.0.1,[::1]";

function noProxyValueCoversLocalhost(value: string | undefined): boolean {
  const entries = new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  return entries.has("localhost") && entries.has("127.0.0.1") && entries.has("[::1]");
}

function appendLoopbackEntries(value: string | undefined): string {
  return value ? `${value},${LOOPBACK_ENTRIES}` : LOOPBACK_ENTRIES;
}

let noProxyLeaseCount = 0;
type NoProxyName = "NO_PROXY" | "no_proxy";
let noProxySnapshot: {
  previous: Record<NoProxyName, string | undefined>;
  applied: Record<NoProxyName, string>;
} | null = null;

/**
 * Scoped NO_PROXY bypass for loopback CDP URLs.
 *
 * This wrapper only mutates env vars for loopback destinations. On restore,
 * it avoids clobbering external NO_PROXY changes that happened while calls
 * were in-flight.
 */
export async function withNoProxyForCdpUrl<T>(url: string, fn: () => Promise<T>): Promise<T> {
  if (!isLoopbackHost(URL.parse(url)?.hostname ?? "") || !hasProxyEnvConfigured()) {
    return await fn();
  }
  if (
    noProxyLeaseCount === 0 &&
    !(
      noProxyValueCoversLocalhost(process.env.NO_PROXY) &&
      noProxyValueCoversLocalhost(process.env.no_proxy)
    )
  ) {
    const previous = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
    const applied = {
      NO_PROXY: appendLoopbackEntries(previous.NO_PROXY || previous.no_proxy),
      no_proxy: appendLoopbackEntries(previous.no_proxy || previous.NO_PROXY),
    };
    Object.assign(process.env, applied);
    noProxySnapshot = { previous, applied };
  }
  noProxyLeaseCount += 1;
  try {
    return await fn();
  } finally {
    noProxyLeaseCount -= 1;
    if (noProxyLeaseCount === 0 && noProxySnapshot) {
      const { previous, applied } = noProxySnapshot;
      // Windows aliases the two keys, so read both before restoring either.
      const current = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
      for (const name of ["NO_PROXY", "no_proxy"] as const) {
        if (current[name] === applied[name]) {
          if (previous[name] !== undefined) {
            process.env[name] = previous[name];
          } else {
            delete process.env[name];
          }
        }
      }
      noProxySnapshot = null;
    }
  }
}

/**
 * Scoped managed-proxy bypass for the exact CDP URL about to be used.
 *
 * Proxyline dynamic bypass registrations are exact URL matches, so callers
 * must register the concrete `/json/version` or `ws://.../devtools/...` URL
 * rather than a CDP base URL.
 */
export function withManagedProxyForCdpUrl<T>(url: string, fn: () => T): T {
  const release = registerManagedProxyBrowserCdpBypass(url);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    release?.();
    throw err;
  }

  const maybeThenable = result as unknown;
  if (
    typeof maybeThenable === "object" &&
    maybeThenable !== null &&
    "finally" in maybeThenable &&
    typeof maybeThenable.finally === "function"
  ) {
    return maybeThenable.finally(() => release?.()) as T;
  }
  release?.();
  return result;
}

/**
 * Validate managed-proxy loopback policy without keeping a long-lived bypass.
 * Exact CDP request sites install their own scoped bypasses.
 */
export function assertManagedProxyAllowsCdpUrl(url: string): void {
  withManagedProxyForCdpUrl(url, () => undefined);
}
