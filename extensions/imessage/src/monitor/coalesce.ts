// Imessage plugin module implements the same-sender inbound debounce merge.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { IMessageAttachment, IMessagePayload } from "./types.js";

/**
 * Bounds on the merged output when multiple inbound iMessage payloads are
 * folded into one agent turn. Caps each merge so a sender who
 * rapid-fires DMs inside the debounce window cannot amplify the downstream
 * prompt past a safe ceiling. Every source GUID still surfaces via
 * `coalescedMessageGuids` so a future replay path can recognize duplicates.
 */
const MAX_COALESCED_TEXT_CHARS = 4000;
const MAX_COALESCED_ATTACHMENTS = 20;
const MAX_COALESCED_ENTRIES = 10;

type CoalescedIMessagePayload = IMessagePayload & {
  /**
   * Source GUIDs folded into this merged payload, in arrival order. Includes
   * GUIDs from entries that were dropped by the entry cap so downstream
   * dedupe paths can still recognize them.
   */
  coalescedMessageGuids?: string[];
  coalescedCatchupCursor?: {
    lastSeenMs: number;
    lastSeenRowid: number;
  };
};

/**
 * Combine consecutive same-sender iMessage payloads into a single payload for
 * downstream dispatch. Used for the general inbound debounce
 * (`messages.inbound`, off by default) when configured.
 *
 * The first payload anchors the merged shape (preserving its GUID for reply
 * threading). Text is concatenated with deduplication, attachments are merged
 * (capped), and the latest `created_at` wins so downstream sees the most
 * recent activity timestamp.
 */
export function combineIMessagePayloads(payloads: IMessagePayload[]): CoalescedIMessagePayload {
  if (payloads.length === 0) {
    throw new Error("combineIMessagePayloads: cannot combine empty payloads");
  }
  const first = expectDefined(payloads[0], "first iMessage payload to coalesce");
  if (payloads.length === 1) {
    return first;
  }

  const seenTexts = new Set<string>();
  const textParts: string[] = [];
  const allAttachments: IMessageAttachment[] = [];
  const seenGuids = new Set<string>();
  const coalescedMessageGuids: string[] = [];
  let textLength = 0;
  let latestCreatedAt: string | undefined;
  let maxRowid = -Infinity;
  let maxDateMs = -Infinity;
  let reply: IMessagePayload | undefined;
  let payloadIndex = 0;
  for (const payload of payloads) {
    const keepContent =
      payloadIndex < MAX_COALESCED_ENTRIES - 1 || payloadIndex === payloads.length - 1;
    payloadIndex += 1;
    // Preserve lexical timestamp selection independently of the parsed recovery timestamp.
    const createdAt = payload.created_at;
    if (
      typeof createdAt === "string" &&
      createdAt.length > 0 &&
      (latestCreatedAt === undefined || createdAt > latestCreatedAt)
    ) {
      latestCreatedAt = createdAt;
    }
    if (typeof payload.id === "number" && Number.isFinite(payload.id)) {
      maxRowid = Math.max(maxRowid, payload.id);
    }
    const dateMs = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
    if (Number.isFinite(dateMs)) {
      maxDateMs = Math.max(maxDateMs, dateMs);
    }
    const guid = payload.guid?.trim();
    if (guid && !seenGuids.has(guid)) {
      seenGuids.add(guid);
      coalescedMessageGuids.push(guid);
    }
    if (!reply && (payload.thread_originator_guid != null || payload.reply_to_guid != null)) {
      reply = payload;
    }

    // Only content is capped to the first entries plus the last; every row contributes metadata.
    if (!keepContent) {
      continue;
    }
    const text = textLength <= MAX_COALESCED_TEXT_CHARS ? (payload.text ?? "").trim() : "";
    if (text) {
      const normalized = seenTexts.size > 0 ? text.toLowerCase() : undefined;
      if (normalized === undefined || !seenTexts.has(normalized)) {
        const separatorLength = textParts.length > 0 ? 1 : 0;
        // One lookahead code unit preserves the final surrogate-safe cut and proves overflow.
        const part = text.slice(0, MAX_COALESCED_TEXT_CHARS + 1 - textLength - separatorLength);
        textParts.push(part);
        textLength += separatorLength + part.length;
        if (textLength <= MAX_COALESCED_TEXT_CHARS) {
          seenTexts.add(normalized ?? text.toLowerCase());
        }
      }
    }
    if (allAttachments.length < MAX_COALESCED_ATTACHMENTS) {
      for (const attachment of payload.attachments ?? []) {
        allAttachments.push(attachment);
        if (allAttachments.length === MAX_COALESCED_ATTACHMENTS) {
          break;
        }
      }
    }
  }
  let combinedText = textParts.join(" ");
  if (textLength > MAX_COALESCED_TEXT_CHARS) {
    combinedText = `${sliceUtf16Safe(combinedText, 0, MAX_COALESCED_TEXT_CHARS)}…[truncated]`;
  }
  reply ??= first;

  return {
    ...first,
    text: combinedText,
    attachments: allAttachments.length > 0 ? allAttachments : null,
    created_at: latestCreatedAt ?? first.created_at,
    thread_originator_guid: reply.thread_originator_guid ?? null,
    reply_to_guid: reply.reply_to_guid ?? null,
    reply_to_text: reply.reply_to_text ?? null,
    reply_to_sender: reply.reply_to_sender ?? null,
    coalescedMessageGuids: coalescedMessageGuids.length > 0 ? coalescedMessageGuids : undefined,
    coalescedCatchupCursor:
      Number.isFinite(maxRowid) && Number.isFinite(maxDateMs)
        ? { lastSeenMs: maxDateMs, lastSeenRowid: maxRowid }
        : undefined,
  };
}
