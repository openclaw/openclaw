import { resolvePinnedHostnameWithPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { canonicalArguments, record } from "./protocol.js";

export type McpEventsConfig = { callbackOrigin: string; maxPendingEvents: number };

export function resolveMcpEventsConfig(value: unknown): McpEventsConfig {
  const config = record(value);
  if (!config || typeof config.callbackOrigin !== "string") {
    throw new Error(
      "Configure mcp-events.callbackOrigin with a public HTTPS origin; expose only the callback route through your reverse proxy",
    );
  }
  let url: URL;
  try {
    url = new URL(config.callbackOrigin);
  } catch {
    throw new Error("MCP Events callbackOrigin must be a public HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "MCP Events callbackOrigin must be a public HTTPS origin without credentials, path, query, or fragment",
    );
  }
  const maxPendingEvents = config.maxPendingEvents ?? 10_000;
  if (
    typeof maxPendingEvents !== "number" ||
    !Number.isSafeInteger(maxPendingEvents) ||
    maxPendingEvents < 1 ||
    maxPendingEvents > 100_000
  ) {
    throw new Error("MCP Events maxPendingEvents must be an integer from 1 to 100000");
  }
  return { callbackOrigin: url.origin, maxPendingEvents };
}

/** DNS/public-address preflight is not a reachability claim or permission to expose the Gateway. */
export async function preflightCallbackOrigin(origin: string, signal: AbortSignal): Promise<void> {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("MCP Events requires a public HTTPS callback");
  }
  await resolvePinnedHostnameWithPolicy(url.hostname, { signal });
}

export function resolveMcpEventSourceOptions(options: Record<string, unknown>) {
  const { server: serverName, name, arguments: input = {} } = options;
  const args = record(input);
  if (
    typeof serverName !== "string" ||
    !serverName.trim() ||
    serverName.length > 256 ||
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 256 ||
    !args
  ) {
    throw new Error("MCP event source options require server, name, and object arguments");
  }
  const canonical = record(JSON.parse(canonicalArguments(args)));
  if (!canonical) {
    throw new Error("MCP event arguments must remain a JSON object");
  }
  return { serverName, name, arguments: canonical };
}
