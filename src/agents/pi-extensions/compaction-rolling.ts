/**
 * Rolling context eviction extension.
 *
 * Intercepts the SDK's `session_before_compact` event and replaces the default
 * LLM-generated summary with a minimal eviction note.  The old messages are
 * still persisted in the session JSONL and remain searchable via memory_search;
 * we simply don't spend tokens summarizing them.
 */
import type { ExtensionAPI, FileOperations } from "@mariozechner/pi-coding-agent";

function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

export default function compactionRollingExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event) => {
    const { preparation } = event;
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);

    const evictedCount = preparation.messagesToSummarize.length;
    const note =
      `[Rolling eviction: ${evictedCount} messages dropped from context. ` +
      `Old messages remain in session JSONL and are searchable via memory_search. ` +
      `Use memory_search to recall prior conversation content.]` +
      fileOpsSummary;

    return {
      compaction: {
        summary: note,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: { readFiles, modifiedFiles },
      },
    };
  });
}
