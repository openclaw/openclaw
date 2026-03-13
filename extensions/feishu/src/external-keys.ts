const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const MAX_EXTERNAL_KEY_LENGTH = 512;

export function normalizeFeishuExternalKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_EXTERNAL_KEY_LENGTH) {
    return undefined;
  }
  if (CONTROL_CHARS_RE.test(normalized)) {
    return undefined;
  }
  // Reject path separators to prevent path traversal attacks.
  // Allow legitimate keys containing ".." as substrings (e.g., "img_v2_test..key").
  if (normalized.includes("/") || normalized.includes("\\")) {
    return undefined;
  }
  return normalized;
}
