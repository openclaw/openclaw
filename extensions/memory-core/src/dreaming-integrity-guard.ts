// Memory Core plugin module implements dreaming memory-file integrity diagnostics.
//
// Diagnostic-only: detects when top-level memory/*.md files disappear during a
// single dreaming run, to help pin down the unresolved deletion mechanism from
// issue #84882. Never throws — a failure to snapshot must not affect dreaming.
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type MemoryDirFileMeta = {
  sizeBytes: number;
  mtimeMs: number;
};

export type MemoryDirSnapshotResult =
  | { ok: true; files: Map<string, MemoryDirFileMeta> }
  | { ok: false; reason: string };

export type MissingMemoryFile = MemoryDirFileMeta & { name: string };

export async function snapshotMemoryDirFiles(
  workspaceDir: string,
): Promise<MemoryDirSnapshotResult> {
  const memoryDir = path.join(workspaceDir, "memory");
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(memoryDir, { withFileTypes: true, encoding: "utf-8" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: true, files: new Map() };
    }
    return { ok: false, reason: formatSnapshotError(err) };
  }

  const files = new Map<string, MemoryDirFileMeta>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    try {
      const stat = await fs.stat(path.join(memoryDir, entry.name));
      files.set(entry.name, { sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        return { ok: false, reason: formatSnapshotError(err) };
      }
      // File raced out between readdir and stat; treat as absent rather than failing.
    }
  }
  return { ok: true, files };
}

export function diffMissingMemoryFiles(
  before: MemoryDirSnapshotResult,
  after: MemoryDirSnapshotResult,
): MissingMemoryFile[] {
  if (!before.ok || !after.ok) {
    return [];
  }
  const missing: MissingMemoryFile[] = [];
  for (const [name, meta] of before.files) {
    if (!after.files.has(name)) {
      missing.push({ name, ...meta });
    }
  }
  return missing;
}

function formatSnapshotError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
