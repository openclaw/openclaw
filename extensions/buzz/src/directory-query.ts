import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/directory-runtime";

function matchesDirectoryQuery(entry: ChannelDirectoryEntry, query: string): boolean {
  if (!query) {
    return true;
  }
  return [entry.id, entry.name, entry.handle].some((value) => value?.toLowerCase().includes(query));
}

export function applyBuzzDirectoryQueryAndLimit(
  entries: ChannelDirectoryEntry[],
  params: { query?: string | null; limit?: number | null },
): ChannelDirectoryEntry[] {
  const query = params.query?.trim().toLowerCase() ?? "";
  const limit =
    typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : undefined;
  const result: ChannelDirectoryEntry[] = [];
  for (const entry of entries) {
    if (!matchesDirectoryQuery(entry, query)) {
      continue;
    }
    result.push(entry);
    if (limit !== undefined && result.length >= limit) {
      break;
    }
  }
  return result;
}
