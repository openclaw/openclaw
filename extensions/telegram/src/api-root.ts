const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";

const TELEGRAM_BOT_ENDPOINT_SEGMENT_RE = /^bot\d+:[^/]+$/u;

function isTelegramBotEndpointSegment(segment: string): boolean {
  try {
    return TELEGRAM_BOT_ENDPOINT_SEGMENT_RE.test(decodeURIComponent(segment));
  } catch {
    return TELEGRAM_BOT_ENDPOINT_SEGMENT_RE.test(segment);
  }
}

export function normalizeTelegramApiRoot(apiRoot?: string): string {
  const trimmed = apiRoot?.trim();
  if (!trimmed) {
    return DEFAULT_TELEGRAM_API_ROOT;
  }

  let normalized = trimmed.replace(/\/+$/u, "");
  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length > 0 && isTelegramBotEndpointSegment(segments[segments.length - 1] ?? "")) {
      segments.pop();
      url.pathname = segments.length > 0 ? `/${segments.join("/")}` : "/";
      url.search = "";
      url.hash = "";
      normalized = url.toString().replace(/\/+$/u, "");
    }
  } catch {
    // Config validation catches invalid URLs; keep legacy runtime behavior for
    // callers that reached this helper with unchecked input.
  }
  return normalized;
}

export function hasTelegramBotEndpointApiRoot(apiRoot: unknown): boolean {
  if (typeof apiRoot !== "string" || !apiRoot.trim()) {
    return false;
  }
  try {
    const url = new URL(apiRoot.trim());
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    return Boolean(last && isTelegramBotEndpointSegment(last));
  } catch {
    return false;
  }
}

function readRequestUrl(input: unknown): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  return null;
}

export function extractTelegramApiMethod(input: unknown): string | null {
  const url = readRequestUrl(input);
  if (!url) {
    return null;
  }
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    return segments.at(-1)?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
