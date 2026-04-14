/**
 * Pull the target domain out of a tool call's parameters.
 *
 * Different tools represent the target differently:
 *   - `web_fetch`, `web_search`, `fetch`: a `url` (or `uri`) parameter
 *   - MCP tools: server config; we don't try to resolve it here
 *
 * This is intentionally narrow: we only return a domain when we're
 * confident, otherwise we return `null` and the hook becomes a no-op
 * for that call. The plugin must never block a tool call just because
 * we couldn't figure out where it's going.
 */

const NETWORK_TOOL_NAMES = new Set([
  "web_fetch",
  "web_search",
  "fetch",
  "http_get",
  "http_request",
  "browser_navigate",
  "browser_open",
]);

/** Returns the lowercase host portion of a URL, or null if not extractable. */
export function extractDomain(
  toolName: string,
  params: Record<string, unknown>,
): string | null {
  if (!isNetworkTool(toolName)) return null;

  const candidate =
    pickString(params, "url") ??
    pickString(params, "uri") ??
    pickString(params, "endpoint") ??
    pickString(params, "target");
  if (!candidate) return null;

  const parsed = safeParseUrl(candidate);
  if (!parsed) return null;

  // Only http(s) is in scope for ADP.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  // Strip any port; ADP discovery is always at the bare host.
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost") return null;

  // Skip IP literals -- ADP is keyed on FQDN.
  if (isIpLiteral(host)) return null;

  return host;
}

export function isNetworkTool(toolName: string): boolean {
  return NETWORK_TOOL_NAMES.has(toolName);
}

function pickString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function isIpLiteral(host: string): boolean {
  // IPv6 in URL form is bracketed; URL parser strips the brackets so
  // the leftover host contains colons.
  if (host.includes(":")) return true;
  // IPv4: four dot-separated decimal octets.
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
