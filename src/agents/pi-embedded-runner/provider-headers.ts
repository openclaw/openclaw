import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

export type ProviderHeaderVars = {
  /** Session key (unique per session); used for e.g. Fireworks x-session-affinity. */
  sessionKey?: string;
  /** Agent id for this run; used for per-agent header values. */
  agentId?: string;
};

const PLACEHOLDERS: Array<{ key: string; name: keyof ProviderHeaderVars }> = [
  { key: "{{session.key}}", name: "sessionKey" },
  { key: "{{agent.id}}", name: "agentId" },
];

/**
 * Interpolate template placeholders in a header value.
 * Supported: {{session.key}}, {{agent.id}}.
 * Unknown placeholders are left as-is. Missing values are replaced with empty string.
 *
 * @internal Exported for testing
 */
export function interpolateHeaderValue(value: string, vars: ProviderHeaderVars): string {
  let out = value;
  for (const { key, name } of PLACEHOLDERS) {
    const v = vars[name];
    out = out.split(key).join(typeof v === "string" ? v : "");
  }
  return out;
}

/**
 * Build headers from provider config, interpolating any template placeholders.
 *
 * @internal Exported for testing
 */
export function resolveProviderHeaders(
  headers: Record<string, string> | undefined,
  vars: ProviderHeaderVars,
): Record<string, string> {
  if (!headers || Object.keys(headers).length === 0) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      out[name] = interpolateHeaderValue(value, vars);
    }
  }
  return out;
}

/**
 * Returns true if any header value contains a template placeholder (e.g. {{session.key}}).
 */
export function hasHeaderTemplates(headers: Record<string, string> | undefined): boolean {
  if (!headers) {
    return false;
  }
  for (const value of Object.values(headers)) {
    if (typeof value === "string" && value.includes("{{")) {
      return true;
    }
  }
  return false;
}

/**
 * Create a streamFn wrapper that merges the given headers into each request's
 * options.headers. Caller should use resolveProviderHeaders() first to interpolate
 * templates if needed.
 */
export function createProviderHeadersStreamFnWrapper(
  baseStreamFn: StreamFn | undefined,
  resolvedHeaders: Record<string, string>,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  if (Object.keys(resolvedHeaders).length === 0) {
    return underlying;
  }
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      headers: {
        ...resolvedHeaders,
        ...options?.headers,
      },
    });
}
