import {
  formatMediaPlaceholderText,
  type MediaPlaceholderTextFact,
} from "openclaw/plugin-sdk/channel-inbound";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";

/** Keeps Signal's established multi-attachment text while sharing single-item rendering. */
export function formatSignalMediaText(media: readonly MediaPlaceholderTextFact[]): string {
  if (media.length <= 1) {
    return formatMediaPlaceholderText(media);
  }
  const kindCounts = new Map<string, number>();
  for (const entry of media) {
    const kind =
      entry.kind && entry.kind !== "unknown"
        ? entry.kind
        : (kindFromMime(entry.contentType) ?? "attachment");
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const parts = [...kindCounts.entries()].map(
    ([kind, count]) => `${count} ${kind === "attachment" ? "file" : kind}${count > 1 ? "s" : ""}`,
  );
  return `[${parts.join(" + ")} attached]`;
}

const SIGNAL_LONG_TEXT_CONTENT_TYPE = "text/x-signal-plain";

/**
 * Signal sends a body over about 2 KB as a truncated body plus a text/x-signal-plain attachment.
 * Once signal-cli has downloaded that attachment it puts the full text in `message`, so the
 * attachment then only repeats the body and isn't media.
 */
export function withoutDuplicateLongText<
  T extends { contentType?: string | null; size?: number | null } | null | undefined,
>(attachments: readonly T[] | null | undefined, message: string): T[] {
  return (attachments ?? []).filter(
    (attachment) =>
      attachment?.contentType?.toLowerCase() !== SIGNAL_LONG_TEXT_CONTENT_TYPE ||
      typeof attachment.size !== "number" ||
      Buffer.byteLength(message, "utf8") < attachment.size,
  );
}
