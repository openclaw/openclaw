import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../shared/reply-payload.types.js";

export function hasAnyNonEmptyString(value: unknown): boolean {
  return Array.isArray(value) && value.some(hasNonEmptyString);
}

export async function normalizeSentMediaUrlsForDelivery(params: {
  sentMediaUrls: readonly string[];
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<string[]> {
  const normalizedUrls = new Set<string>();
  for (const raw of params.sentMediaUrls) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    normalizedUrls.add(trimmed);
    if (!params.normalizeMediaPaths) {
      continue;
    }
    try {
      const normalized = await params.normalizeMediaPaths({
        mediaUrl: trimmed,
        mediaUrls: [trimmed],
      });
      for (const mediaUrl of [normalized.mediaUrl, ...(normalized.mediaUrls ?? [])]) {
        const candidate = mediaUrl?.trim();
        if (candidate) {
          normalizedUrls.add(candidate);
        }
      }
    } catch {
      // Keep the original evidence. Delivery normalization will report invalid media separately.
    }
  }
  return [...normalizedUrls];
}
