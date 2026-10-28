import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/directory-runtime";

export function applyBuzzDirectoryQueryAndLimit(
  entries: ChannelDirectoryEntry[],
  params: { query?: string | null; limit?: number | null },
): ChannelDirectoryEntry[] {
  const query = params.query?.trim().toLowerCase() ?? "";
  const limit = params.limit != null && params.limit > 0 ? Math.floor(params.limit) : undefined;
  const result: ChannelDirectoryEntry[] = [];
  for (const entry of entries) {
    if (
      query &&
      ![entry.id, entry.name, entry.handle].some((value) => value?.toLowerCase().includes(query))
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
