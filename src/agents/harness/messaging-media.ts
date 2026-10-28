import { isRecord } from "@openclaw/normalization-core/record-coerce";

const MESSAGE_MEDIA_KEYS = [
  "media",
  "mediaUrl",
  "media_url",
  "path",
  "filePath",
  "fileUrl",
  "imageUrl",
  "image_url",
] as const;
const MESSAGE_MEDIA_ARRAY_KEYS = ["mediaUrls", "media_urls", "imageUrls", "image_urls"] as const;
const HARNESS_SCALAR_ALIASES = new Set(["media_url", "imageUrl", "image_url"]);
const ATTACHMENT_MEDIA_KEYS = ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"] as const;

export function mapAgentHarnessMessagingMediaValues(
  args: Record<string, unknown>,
  mapValue: (value: string) => string,
  includeHarnessAliases = true,
): Record<string, unknown> {
  const mapString = (value: unknown) => (typeof value === "string" ? mapValue(value) : value);
  const mapArray = (values: unknown, map: (value: unknown) => unknown) => {
    if (!Array.isArray(values)) {
      return values;
    }
    const mapped = values.map(map);
    return mapped.some((value, index) => value !== values[index]) ? mapped : values;
  };
  const mapRecord = (
    record: Record<string, unknown>,
    keys: readonly string[],
    message = false,
  ): Record<string, unknown> => {
    let mapped = record;
    const assign = (key: string, value: unknown) => {
      if (value !== record[key]) {
        if (mapped === record) {
          mapped = { ...record };
        }
        mapped[key] = value;
      }
    };
    for (const key of keys) {
      if (!message || includeHarnessAliases || !HARNESS_SCALAR_ALIASES.has(key)) {
        assign(key, mapString(record[key]));
      }
    }
    if (message) {
      for (const key of includeHarnessAliases ? MESSAGE_MEDIA_ARRAY_KEYS : ["mediaUrls"]) {
        assign(key, mapArray(record[key], mapString));
      }
      assign(
        "attachments",
        mapArray(record.attachments, (attachment) =>
          isRecord(attachment) ? mapRecord(attachment, ATTACHMENT_MEDIA_KEYS) : attachment,
        ),
      );
    }
    return mapped;
  };
  return mapRecord(args, MESSAGE_MEDIA_KEYS, true);
}

/** Ordered references for delivery evidence; repeated sources remain distinct entries. */
export function collectAgentHarnessMessagingMediaUrls(record: Record<string, unknown>): string[] {
  const urls: string[] = [];
  mapAgentHarnessMessagingMediaValues(record, (value) => {
    const trimmed = value.trim();
    if (trimmed) {
      urls.push(trimmed);
    }
    return value;
  });
  return urls;
}
