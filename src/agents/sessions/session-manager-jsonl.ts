import { logWarn } from "../../logger.js";
import { normalizeLoadedFileEntry } from "./session-manager-codec.js";
import type { FileEntry } from "./session-manager-types.js";

// Legacy JSONL diagnostics stay host-owned; transcript navigation needs no logger.
export function parseSessionEntries(content: string): FileEntry[] {
  const entries: FileEntry[] = [];
  let skipped = 0;
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(normalizeLoadedFileEntry(JSON.parse(line) as FileEntry));
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    logWarn(
      `parseJsonlEntries: skipped ${skipped} malformed JSONL line(s) — ` +
        `${entries.length} valid entries were loaded`,
    );
  }
  return entries;
}
