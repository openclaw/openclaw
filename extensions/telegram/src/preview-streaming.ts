export type TelegramPreviewStreamMode = "off" | "partial" | "block";

function normalizeStreamingMode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function parseStreamingMode(value: unknown): "off" | "partial" | "block" | "progress" | null {
  const normalized = normalizeStreamingMode(value);
  if (
    normalized === "off" ||
    normalized === "partial" ||
    normalized === "block" ||
    normalized === "progress"
  ) {
    return normalized;
  }
  return null;
}

function parseTelegramPreviewStreamMode(value: unknown): TelegramPreviewStreamMode | null {
  const parsed = parseStreamingMode(value);
  if (!parsed) {
    return null;
  }
  return parsed === "progress" ? "partial" : parsed;
}

export function resolveTelegramPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): TelegramPreviewStreamMode {
  const parsedStreaming = parseStreamingMode(params.streaming);
  if (parsedStreaming) {
    if (parsedStreaming === "progress") {
      return "partial";
    }
    return parsedStreaming;
  }

  const legacy = parseTelegramPreviewStreamMode(params.streamMode);
  if (legacy) {
    return legacy;
  }
  if (typeof params.streaming === "boolean") {
    return params.streaming ? "partial" : "off";
  }
  return "partial";
}
