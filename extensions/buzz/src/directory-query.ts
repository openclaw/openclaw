import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/directory-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function applyBuzzDirectoryQueryAndLimit(
  entries: ChannelDirectoryEntry[],
  params: { query?: string | null; limit?: number | null },
): ChannelDirectoryEntry[] {
  // Canonical forms compare equal here; entries keep their original spelling.
  const query = normalizeLowercaseStringOrEmpty(params.query).normalize("NFC");
  const limit = params.limit != null && params.limit > 0 ? Math.floor(params.limit) : undefined;
  const result: ChannelDirectoryEntry[] = [];
  for (const entry of entries) {
    if (
      query &&
      ![entry.id, entry.name, entry.handle].some((value) =>
        normalizeLowercaseStringOrEmpty(value).normalize("NFC").includes(query),
      )
    ) {
      continue;
    }
    result.push(entry);
    if (limit !== undefined && result.length >= limit) {
      break;
    }
  }
  return result;
}
