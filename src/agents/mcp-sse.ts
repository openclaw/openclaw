type SseMcpServerLaunchConfig = {
  url: string;
  headers?: Record<string, string>;
};

type SseMcpServerLaunchResult =
  | { ok: true; config: SseMcpServerLaunchConfig }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toStringRecord(
  value: unknown,
  warnDropped?: (key: string, entry: unknown) => void,
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, entry]) => {
      if (typeof entry === "string") {
        return [key, entry] as const;
      }
      if (typeof entry === "number" || typeof entry === "boolean") {
        return [key, String(entry)] as const;
      }
      warnDropped?.(key, entry);
      return null;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function resolveSseMcpServerLaunchConfig(
  raw: unknown,
  options?: {
    onDroppedHeader?: (key: string, value: unknown) => void;
    onMalformedHeaders?: (value: unknown) => void;
  },
): SseMcpServerLaunchResult {
  if (!isRecord(raw)) {
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
    // Redact potential credentials and sensitive query params from the invalid URL.
    const redactedUrl = url
      .replace(/\/\/([^@]+)@/, "//***:***@")
      .replace(
        /([?&])(token|key|api_key|apikey|secret|access_token|password|pass|auth|client_secret|refresh_token)=([^&]*)/gi,
        "$1$2=***",
      );
    return { ok: false, reason: `its url is not a valid URL: ${redactedUrl}` };
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
    if (!isRecord(raw.headers)) {
      options?.onMalformedHeaders?.(raw.headers);
    } else {
      headers = toStringRecord(raw.headers, options?.onDroppedHeader);
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
  try {
    const parsed = new URL(config.url);
    // Redact embedded credentials and query-token auth from log/description output.
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = parsed.password ? "***" : "";
    }
    for (const key of parsed.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (
        lower === "token" ||
        lower === "key" ||
        lower === "api_key" ||
        lower === "apikey" ||
        lower === "secret" ||
        lower === "access_token" ||
        lower === "password" ||
        lower === "pass" ||
        lower === "auth" ||
        lower === "client_secret" ||
        lower === "refresh_token"
      ) {
        parsed.searchParams.set(key, "***");
      }
    }
    return parsed.toString();
  } catch {
    return config.url;
  }
}

export type { SseMcpServerLaunchConfig, SseMcpServerLaunchResult };
