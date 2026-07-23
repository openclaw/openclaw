import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Safe Record cast: null/array/primitives → undefined. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Extracts the visible reply text from a standalone message-tool JSON envelope.
 * Returns undefined when the text is not a message-tool send, or when the
 * routing mode does not allow this type of reply unwrapping.
 */
export function extractStandaloneMessageToolText(
  text: string,
  params: { allowCurrentSourceReply?: boolean; allowRoutedReply?: boolean } = {},
): string | undefined {
  try {
    const record = asRecord(JSON.parse(text.trim()) as unknown);
    const args = asRecord(record?.arguments);
    const hasRoute = Boolean(
      normalizeOptionalString(args?.target) ||
      normalizeOptionalString(args?.to) ||
      normalizeOptionalString(args?.channel) ||
      normalizeOptionalString(args?.accountId) ||
      Array.isArray(args?.targets),
    );
    if (
      normalizeOptionalString(record?.name) !== "message" ||
      normalizeOptionalString(args?.action) !== "send" ||
      (hasRoute ? !params.allowRoutedReply : !params.allowCurrentSourceReply)
    ) {
      return undefined;
    }
    return normalizeOptionalString(args?.message);
  } catch {
    return undefined;
  }
}

/**
 * Returns true when `text` is a JSON object with name="message" and
 * arguments.action="send". Used as a fast shape check to decide whether
 * the raw content is a message-tool envelope that handleMessageEnd should
 * pass through instead of letting sanitizeUserFacingText strip it.
 */
export function isMessageToolEnvelope(text: string): boolean {
  try {
    const record = asRecord(JSON.parse(text.trim()) as unknown);
    if (normalizeOptionalString(record?.name) !== "message") {
      return false;
    }
    const args = asRecord(record?.arguments);
    return normalizeOptionalString(args?.action) === "send";
  } catch {
    return false;
  }
}
