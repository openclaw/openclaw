type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function extractErrorMessage(
  value: unknown,
  seen: WeakSet<object>
): string | null {
  if (value == null) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  if (value instanceof Error) {
    const msg = value.message?.trim();
    if (msg) return msg;
    const cause = extractErrorMessage(
      (value as Error & { cause?: unknown }).cause,
      seen
    );
    return cause || value.name || null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractErrorMessage(item, seen))
      .filter((item): item is string => Boolean(item));
    if (parts.length > 0) return parts.join("; ");
    return null;
  }

  if (!isRecord(value)) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const keysToTry = [
    "message",
    "error",
    "reason",
    "detail",
    "details",
    "cause",
    "description",
  ];
  for (const key of keysToTry) {
    if (key in value) {
      const nested = extractErrorMessage(value[key], seen);
      if (nested) return nested;
    }
  }

  try {
    const json = JSON.stringify(value);
    if (json && json !== "{}") return json;
  } catch {
    // Ignore stringify errors and fall through.
  }
  return null;
}

export function formatError(
  error: unknown,
  fallback = "Unknown error"
): string {
  const message = extractErrorMessage(error, new WeakSet());
  return message || fallback;
}
