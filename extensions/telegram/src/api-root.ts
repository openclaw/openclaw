export const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";

const TELEGRAM_BOT_ENDPOINT_SEGMENT_RE = /^bot\d+:[^/]+$/u;

function isTelegramBotEndpointSegment(segment: string): boolean {
  try {
    return TELEGRAM_BOT_ENDPOINT_SEGMENT_RE.test(decodeURIComponent(segment));
  } catch {
    return TELEGRAM_BOT_ENDPOINT_SEGMENT_RE.test(segment);
  }
}

function splitNonEmptyPathSegments(pathname: string): string[] {
  const segments: string[] = [];
  for (const segment of pathname.split("/")) {
    if (segment) {
      segments.push(segment);
    }
  }
  return segments;
}

function lastNonEmptyPathSegment(pathname: string): string | undefined {
  let end = pathname.length;
  while (end > 0 && pathname[end - 1] === "/") {
    end--;
  }
  if (end === 0) {
    return undefined;
  }
  const start = pathname.lastIndexOf("/", end - 1) + 1;
  return pathname.slice(start, end) || undefined;
}

export function normalizeTelegramApiRoot(apiRoot?: string): string {
  const trimmed = apiRoot?.trim();
  if (!trimmed) {
    return DEFAULT_TELEGRAM_API_ROOT;
  }

  let normalized = trimmed.replace(/\/+$/u, "");
  try {
    const url = new URL(normalized);
    const segments = splitNonEmptyPathSegments(url.pathname);
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
    const last = lastNonEmptyPathSegment(url.pathname);
    return Boolean(last && isTelegramBotEndpointSegment(last));
  } catch {
    return false;
  }
}
