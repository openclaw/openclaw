export type DiscordPreviewStreamMode = "off" | "partial" | "block";

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

function parseDiscordPreviewStreamMode(value: unknown): DiscordPreviewStreamMode | null {
  const parsed = parseStreamingMode(value);
  if (!parsed) {
    return null;
  }
  return parsed === "progress" ? "partial" : parsed;
}

export function resolveDiscordPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): DiscordPreviewStreamMode {
  const parsedStreaming = parseDiscordPreviewStreamMode(params.streaming);
  if (parsedStreaming) {
    return parsedStreaming;
  }

  const legacy = parseDiscordPreviewStreamMode(params.streamMode);
  if (legacy) {
    return legacy;
  }
  if (typeof params.streaming === "boolean") {
    return params.streaming ? "partial" : "off";
  }
  return "off";
}
