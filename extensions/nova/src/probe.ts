import type { NovaConfig } from "./types.js";
import { resolveNovaCredentials } from "./credentials.js";

export type ProbeNovaResult = {
  ok: boolean;
  error?: string;
  userId?: string;
};

/**
 * Verify Nova credentials are present and the base URL is valid.
 * Does not attempt an actual WS connection (that happens in the monitor).
 */
export function probeNova(cfg?: NovaConfig): ProbeNovaResult {
  const creds = resolveNovaCredentials(cfg);
  if (!creds) {
    return {
      ok: false,
      error: "missing credentials (apiKey, userId)",
    };
  }

  // Validate URL format
  try {
    const url = new URL(creds.baseUrl);
    if (url.protocol !== "wss:" && url.protocol !== "ws:") {
      return {
        ok: false,
        error: `baseUrl must use wss:// protocol (got ${url.protocol})`,
        userId: creds.userId,
      };
    }
  } catch {
    return {
      ok: false,
      error: "baseUrl is not a valid URL",
      userId: creds.userId,
    };
  }

  return { ok: true, userId: creds.userId };
}
