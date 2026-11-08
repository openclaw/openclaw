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

  if (hasTelegramBotEndpointApiRoot(trimmed)) {
    throw new Error(
      "Telegram apiRoot must be the Bot API root without /bot<TOKEN>. Run openclaw doctor --fix to repair stored config.",
    );
  }
  return trimmed.replace(/\/+$/u, "");
}

export function hasTelegramBotEndpointApiRoot(apiRoot: unknown): boolean {
  if (typeof apiRoot !== "string" || !apiRoot.trim()) {
    return false;
  }
  const segments = URL.parse(apiRoot.trim())?.pathname.split("/").filter(Boolean);
  const last = segments?.at(-1);
  return Boolean(last && isTelegramBotEndpointSegment(last));
}

export function extractTelegramApiMethod(input: unknown): string | null {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : null;
  const segments = URL.parse(url ?? "")
    ?.pathname.split("/")
    .filter(Boolean);
  return segments?.at(-1)?.toLowerCase() ?? null;
}
