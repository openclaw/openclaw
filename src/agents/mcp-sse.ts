import {
  redactSensitiveUrl,
  redactSensitiveUrlLikeString,
} from "../shared/net/redact-sensitive-url.js";
import { isMcpConfigRecord, toMcpStringRecord } from "./mcp-config-shared.js";

type SseMcpServerLaunchConfig = {
  url: string;
  headers?: Record<string, string>;
};

type SseMcpServerLaunchResult =
  | { ok: true; config: SseMcpServerLaunchConfig }
  | { ok: false; reason: string };

export function resolveSseMcpServerLaunchConfig(
  raw: unknown,
  options?: {
    onDroppedHeader?: (key: string, value: unknown) => void;
    onMalformedHeaders?: (value: unknown) => void;
  },
): SseMcpServerLaunchResult {
  if (!isMcpConfigRecord(raw)) {
    return { ok: false, reason: "server config must be an object" };
  }
  if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
    return { ok: false, reason: "its url is missing" };
  }
  const url = raw.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      reason: `its url is not a valid URL: ${redactSensitiveUrlLikeString(url)}`,
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `only http and https URLs are supported, got ${parsed.protocol}`,
    };
  }
  // Warn if headers is present but not an object (e.g. a string or array).
  let headers: Record<string, string> | undefined;
  if (raw.headers !== undefined && raw.headers !== null) {
    if (!isMcpConfigRecord(raw.headers)) {
      options?.onMalformedHeaders?.(raw.headers);
    } else {
      headers = toMcpStringRecord(raw.headers, {
        onDroppedEntry: options?.onDroppedHeader,
      });
    }
  }
  return {
    ok: true,
    config: {
      url,
      headers,
    },
  };
}

export function describeSseMcpServerLaunchConfig(config: SseMcpServerLaunchConfig): string {
  return redactSensitiveUrl(config.url);
}

export type { SseMcpServerLaunchConfig, SseMcpServerLaunchResult };
