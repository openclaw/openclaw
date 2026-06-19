function normalizeErrorText(raw: string): string {
  return raw.toLowerCase().replace(/[\s_-]+/g, " ");
}

/**
 * Narrowly match provider errors that explicitly say an image was rejected for
 * sensitive/safety moderation. This intentionally does not match generic
 * schema, network, or unsupported-image errors.
 */
export function isSensitiveImageRejectionError(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  const normalized = normalizeErrorText(raw);
  if (normalized.includes("new sensitive") && normalized.includes("image")) {
    return true;
  }
  if (normalized.includes("image is sensitive")) {
    return true;
  }
  if (
    normalized.includes("image") &&
    normalized.includes("sensitive") &&
    /messages?\[\d+\].*content\[\d+\]/i.test(raw)
  ) {
    return true;
  }
  return false;
}
