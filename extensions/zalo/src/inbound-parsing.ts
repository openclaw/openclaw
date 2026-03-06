import type { ZaloMessage, ZaloUpdate } from "./api.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asNonEmptyString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

type LinkPreview = {
  title?: string;
  url?: string;
  description?: string;
};

function extractLinkPreview(value: unknown): LinkPreview | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const preview = {
    title: readFirstString(record, ["title", "name", "caption"]),
    url: readFirstString(record, [
      "url",
      "link",
      "href",
      "media_url",
      "original_url",
      "originalUrl",
    ]),
    description: readFirstString(record, ["description", "desc", "summary"]),
  };
  if (!preview.title && !preview.url && !preview.description) {
    return undefined;
  }
  return preview;
}

function pushUniquePreview(
  target: string[],
  seen: Set<string>,
  preview: LinkPreview | undefined,
): void {
  if (!preview) {
    return;
  }
  const block = [preview.title, preview.url, preview.description].filter(Boolean).join("\n").trim();
  if (!block) {
    return;
  }
  if (seen.has(block)) {
    return;
  }
  seen.add(block);
  target.push(block);
}

function collectAttachmentPreviewCandidates(attachment: Record<string, unknown>): Array<unknown> {
  const candidates: Array<unknown> = [attachment];
  const nestedKeys = ["payload", "data", "link", "preview", "meta", "metadata"];
  for (const key of nestedKeys) {
    const nested = attachment[key];
    if (nested) {
      candidates.push(nested);
    }
  }
  return candidates;
}

export function extractLinkPreviewText(message: ZaloMessage): string | undefined {
  const blocks: string[] = [];
  const seen = new Set<string>();

  pushUniquePreview(blocks, seen, extractLinkPreview(message.link));
  if (Array.isArray(message.links)) {
    for (const link of message.links) {
      pushUniquePreview(blocks, seen, extractLinkPreview(link));
    }
  }

  for (const attachmentRaw of message.attachments ?? []) {
    const attachment = asRecord(attachmentRaw);
    if (!attachment) {
      continue;
    }
    const typeHint = `${asNonEmptyString(attachment.type) ?? ""} ${
      asNonEmptyString(attachment.media_type) ?? ""
    }`
      .toLowerCase()
      .trim();
    if (typeHint && !typeHint.includes("link")) {
      continue;
    }
    for (const candidate of collectAttachmentPreviewCandidates(attachment)) {
      pushUniquePreview(blocks, seen, extractLinkPreview(candidate));
    }
  }

  if (blocks.length === 0) {
    return undefined;
  }
  return blocks.join("\n\n");
}

type ParsedImage = {
  url: string;
  source: string;
};

function readImageUrlFromRecord(record: Record<string, unknown>): string | undefined {
  return readFirstString(record, [
    "url",
    "photo_url",
    "photoUrl",
    "media_url",
    "download_url",
    "src",
    "image_url",
    "imageUrl",
    "thumb_url",
    "thumbUrl",
  ]);
}

function parsePhotoValue(photo: ZaloMessage["photo"]): ParsedImage | undefined {
  if (typeof photo === "string") {
    const url = asNonEmptyString(photo);
    return url ? { url, source: "photo:string" } : undefined;
  }
  if (Array.isArray(photo)) {
    for (const entry of photo) {
      if (typeof entry === "string") {
        const url = asNonEmptyString(entry);
        if (url) {
          return { url, source: "photo:array:string" };
        }
      } else {
        const record = asRecord(entry);
        if (!record) {
          continue;
        }
        const url = readImageUrlFromRecord(record);
        if (url) {
          return { url, source: "photo:array:object" };
        }
      }
    }
    return undefined;
  }
  const photoRecord = asRecord(photo);
  if (!photoRecord) {
    return undefined;
  }
  const url = readImageUrlFromRecord(photoRecord);
  return url ? { url, source: "photo:object" } : undefined;
}

function parseAttachmentImage(attachmentRaw: unknown): ParsedImage | undefined {
  const attachment = asRecord(attachmentRaw);
  if (!attachment) {
    return undefined;
  }
  const typeHint = `${asNonEmptyString(attachment.type) ?? ""} ${
    asNonEmptyString(attachment.media_type) ?? ""
  }`
    .toLowerCase()
    .trim();
  if (typeHint && !typeHint.includes("image") && !typeHint.includes("photo")) {
    return undefined;
  }
  for (const candidate of collectAttachmentPreviewCandidates(attachment)) {
    const record = asRecord(candidate);
    if (!record) {
      continue;
    }
    const url = readImageUrlFromRecord(record);
    if (url) {
      return { url, source: "attachments" };
    }
  }
  return undefined;
}

export function resolveInboundImageUrl(message: ZaloMessage): ParsedImage | undefined {
  const fromTopLevel = readImageUrlFromRecord(message as unknown as Record<string, unknown>);
  if (fromTopLevel) {
    return { url: fromTopLevel, source: "message:top-level" };
  }

  const fromPhoto = parsePhotoValue(message.photo);
  if (fromPhoto) {
    return fromPhoto;
  }
  for (const attachment of message.attachments ?? []) {
    const parsed = parseAttachmentImage(attachment);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

export function resolveInboundStickerUrl(message: ZaloMessage): string | undefined {
  const topLevelUrl = asNonEmptyString((message as unknown as Record<string, unknown>).url);
  if (topLevelUrl) {
    return topLevelUrl;
  }

  for (const attachment of message.attachments ?? []) {
    const record = asRecord(attachment);
    if (!record) {
      continue;
    }
    const typeHint =
      `${asNonEmptyString(record.type) ?? ""} ${asNonEmptyString(record.media_type) ?? ""}`
        .toLowerCase()
        .trim();
    if (typeHint && !typeHint.includes("sticker")) {
      continue;
    }
    const stickerUrl = readImageUrlFromRecord(record);
    if (stickerUrl) {
      return stickerUrl;
    }
    for (const candidate of collectAttachmentPreviewCandidates(record)) {
      const nested = asRecord(candidate);
      if (!nested) {
        continue;
      }
      const nestedUrl = readImageUrlFromRecord(nested);
      if (nestedUrl) {
        return nestedUrl;
      }
    }
  }

  return undefined;
}

export function resolveInboundText(message: ZaloMessage): string | undefined {
  return asNonEmptyString(message.text) ?? extractLinkPreviewText(message);
}

export function describeInboundImagePayload(message: ZaloMessage): string {
  const photo = message.photo;
  const photoUrl = readFirstString(message as unknown as Record<string, unknown>, [
    "photo_url",
    "photoUrl",
  ]);
  const photoDescriptor = Array.isArray(photo)
    ? `array(${String(photo.length)})`
    : photo === undefined
      ? "none"
      : typeof photo;
  const attachmentCount = message.attachments?.length ?? 0;
  const attachmentTypes = (message.attachments ?? [])
    .map((entry) => asNonEmptyString(entry.type) ?? asNonEmptyString(entry.media_type) ?? "unknown")
    .slice(0, 4)
    .join(",");
  return `photo=${photoDescriptor} photo_url=${photoUrl ? "present" : "none"} attachments=${String(
    attachmentCount,
  )}${attachmentTypes ? ` types=${attachmentTypes}` : ""}`;
}

export type UnsupportedInboundSummary = {
  kind: string;
  details?: string;
};

const BASE_MESSAGE_KEYS = new Set([
  "message_id",
  "from",
  "chat",
  "date",
  "message_type",
  "text",
  "url",
  "photo_url",
  "photo",
  "caption",
  "sticker",
  "link",
  "links",
  "attachments",
]);

function collectAttachmentTypeHints(message: ZaloMessage): string[] {
  const hints = new Set<string>();
  for (const entry of message.attachments ?? []) {
    const type = asNonEmptyString(entry.type) ?? asNonEmptyString(entry.media_type);
    if (type) {
      hints.add(type);
    }
  }
  return Array.from(hints);
}

function collectExtraMessageKeys(message: ZaloMessage): string[] {
  const record = message as unknown as Record<string, unknown>;
  return Object.keys(record)
    .filter((key) => !BASE_MESSAGE_KEYS.has(key))
    .slice(0, 6);
}

export function summarizeUnsupportedInbound(message: ZaloMessage): UnsupportedInboundSummary {
  const kindHints: string[] = [];

  const attachmentTypes = collectAttachmentTypeHints(message);
  if (attachmentTypes.length > 0) {
    kindHints.push(`attachment:${attachmentTypes.join(",")}`);
  } else if ((message.attachments?.length ?? 0) > 0) {
    kindHints.push("attachment");
  }

  if (message.sticker) {
    kindHints.push("sticker");
  }
  if (message.photo) {
    kindHints.push("image");
  }
  if (message.link || (message.links?.length ?? 0) > 0) {
    kindHints.push("link-preview");
  }

  const extraKeys = collectExtraMessageKeys(message);
  if (extraKeys.includes("file")) {
    kindHints.push("file");
  }
  if (extraKeys.includes("voice")) {
    kindHints.push("voice");
  }
  if (extraKeys.includes("audio")) {
    kindHints.push("audio");
  }
  if (extraKeys.includes("video")) {
    kindHints.push("video");
  }

  const uniqueKindHints = Array.from(new Set(kindHints));
  const kind = uniqueKindHints.length > 0 ? uniqueKindHints.join(" + ") : "unknown";
  const details = extraKeys.length > 0 ? `fields=${extraKeys.join(",")}` : undefined;
  return { kind, details };
}

export function formatUpdateForLog(update: ZaloUpdate, maxChars = 1500): string {
  try {
    const serialized = JSON.stringify(update);
    if (!serialized) {
      return "<empty>";
    }
    if (serialized.length <= maxChars) {
      return serialized;
    }
    return `${serialized.slice(0, maxChars)}...`;
  } catch {
    return "<unserializable>";
  }
}
