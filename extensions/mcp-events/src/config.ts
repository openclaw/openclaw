import { resolvePinnedHostnameWithPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord as record } from "openclaw/plugin-sdk/string-coerce-runtime";
import { canonicalArguments } from "./protocol.js";

/** `callbackBaseUrl` is the HTTPS origin plus any path prefix, without a trailing slash. */
export type McpEventsConfig = { callbackBaseUrl: string; maxPendingEvents: number };

function resolveCallbackBaseUrl(value: unknown): string {
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {}
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      "MCP Events callbackBaseUrl must be a public HTTPS URL without credentials, query, or fragment",
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function resolveMcpEventsConfig(value: unknown): McpEventsConfig {
  const config = record(value);
  if (config?.callbackBaseUrl === undefined) {
    throw new Error(
      "Configure mcp-events.callbackBaseUrl with a public HTTPS URL; expose only the callback route through your reverse proxy",
    );
  }
  const callbackBaseUrl = resolveCallbackBaseUrl(config.callbackBaseUrl);
  const maxPendingEvents = config.maxPendingEvents ?? 10_000;
  if (
    typeof maxPendingEvents !== "number" ||
    !Number.isSafeInteger(maxPendingEvents) ||
    maxPendingEvents < 1 ||
    maxPendingEvents > 100_000
  ) {
    throw new Error("MCP Events maxPendingEvents must be an integer from 1 to 100000");
  }
  return { callbackBaseUrl, maxPendingEvents };
}

/** DNS/public-address preflight is not a reachability claim or permission to expose the Gateway. */
export async function preflightCallbackBaseUrl(
  baseUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL(baseUrl);
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
