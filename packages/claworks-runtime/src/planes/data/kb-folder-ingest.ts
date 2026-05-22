import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { KnowledgeBase } from "../../kernel/types.js";

export type KbFolderIngestOptions = {
  folder_path: string;
  namespace?: string;
  recursive?: boolean;
  file_types?: string[];
  source_prefix?: string;
};

export type KbFolderIngestFileResult = {
  file: string;
  status: "ok" | "error";
  reason?: string;
};

export type KbFolderIngestResult = {
  ingested: number;
  errors: number;
  total: number;
  results: KbFolderIngestFileResult[];
};

const DEFAULT_EXTENSIONS = [".txt", ".md", ".markdown", ".json", ".csv", ".yaml", ".yml"];

function normalizeExtensions(fileTypes?: string[]): Set<string> {
  return new Set((fileTypes ?? DEFAULT_EXTENSIONS).map((e) => (e.startsWith(".") ? e : `.${e}`)));
}

function collectFiles(dir: string, recursive: boolean, allowedExts: Set<string>): string[] {
  try {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory() && recursive) {
          return collectFiles(full, recursive, allowedExts);
        }
        if (st.isFile() && allowedExts.has(extname(entry).toLowerCase())) {
          return [full];
        }
      } catch {
        // skip unreadable entries
      }
      return [];
    });
  } catch {
    return [];
  }
}

/** Batch-ingest text files from a folder into the knowledge base. */
export async function ingestKbFolder(
  kb: KnowledgeBase,
  opts: KbFolderIngestOptions,
): Promise<KbFolderIngestResult> {
  const folderPath = opts.folder_path.trim();
  if (!folderPath) {
    throw new Error("folder_path is required");
  }
  const recursive = opts.recursive !== false;
  const allowedExts = normalizeExtensions(opts.file_types);
  const files = collectFiles(folderPath, recursive, allowedExts);
  const results: KbFolderIngestFileResult[] = [];

  for (const file of files) {
    try {
      const text = readFileSync(file, "utf-8");
      const source = opts.source_prefix
        ? `${opts.source_prefix}/${file.slice(folderPath.length + 1)}`
        : file;
      await kb.ingest(text, { namespace: opts.namespace, source });
      results.push({ file, status: "ok" });
    } catch (err) {
      results.push({
        file,
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (typeof kb.flush === "function") {
    await kb.flush();
  }

  return {
    ingested: results.filter((r) => r.status === "ok").length,
    errors: results.filter((r) => r.status === "error").length,
    total: files.length,
    results,
  };
}
