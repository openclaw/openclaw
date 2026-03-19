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

function toStringRecord(value: unknown): Record<string, string> | undefined {
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
      return null;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function resolveSseMcpServerLaunchConfig(raw: unknown): SseMcpServerLaunchResult {
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
    return { ok: false, reason: `its url is not a valid URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `only http and https URLs are supported, got ${parsed.protocol}`,
    };
  }
  return {
    ok: true,
    config: {
      url,
      headers: toStringRecord(raw.headers),
    },
  };
}

export function describeSseMcpServerLaunchConfig(config: SseMcpServerLaunchConfig): string {
  return config.url;
}

export type { SseMcpServerLaunchConfig, SseMcpServerLaunchResult };
