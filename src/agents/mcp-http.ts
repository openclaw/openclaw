import {
  redactSensitiveUrl,
  redactSensitiveUrlLikeString,
} from "../shared/net/redact-sensitive-url.js";
import { isMcpConfigRecord, toMcpStringRecord } from "./mcp-config-shared.js";

/** Expand `${ENV_VAR}` references in a string using `process.env`. */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    const envValue = process.env[name.trim()];
    return envValue ?? _match; // leave unresolved refs as-is
  });
}

/** Expand env vars in all values of a string record. */
function expandEnvVarsInRecord(
  record: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = expandEnvVars(value);
  }
  return result;
}

export type HttpMcpTransportType = "sse" | "streamable-http";

export type HttpMcpServerLaunchConfig = {
  transportType: HttpMcpTransportType;
  url: string;
  headers?: Record<string, string>;
};

export type HttpMcpServerLaunchResult =
  | { ok: true; config: HttpMcpServerLaunchConfig }
  | { ok: false; reason: string };

export function resolveHttpMcpServerLaunchConfig(
  raw: unknown,
  options?: {
    transportType?: HttpMcpTransportType;
    onDroppedHeader?: (key: string, value: unknown) => void;
    onMalformedHeaders?: (value: unknown) => void;
  },
): HttpMcpServerLaunchResult {
  if (!isMcpConfigRecord(raw)) {
    return { ok: false, reason: "server config must be an object" };
  }
  if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
    return { ok: false, reason: "its url is missing" };
  }
  const url = expandEnvVars(raw.url.trim());
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

  let headers: Record<string, string> | undefined;
  if (raw.headers !== undefined && raw.headers !== null) {
    if (!isMcpConfigRecord(raw.headers)) {
      options?.onMalformedHeaders?.(raw.headers);
    } else {
      headers = expandEnvVarsInRecord(
        toMcpStringRecord(raw.headers, {
          onDroppedEntry: options?.onDroppedHeader,
        }) ?? {},
      );
      if (Object.keys(headers).length === 0) {
        headers = undefined;
      }
    }
  }

  return {
    ok: true,
    config: {
      transportType: options?.transportType ?? "sse",
      url,
      headers,
    },
  };
}

export function describeHttpMcpServerLaunchConfig(config: HttpMcpServerLaunchConfig): string {
  return redactSensitiveUrl(config.url);
}
