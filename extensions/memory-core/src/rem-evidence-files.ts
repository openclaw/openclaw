import path from "node:path";
import { inspectWorkspaceFile, listWorkspaceDirectory } from "./memory-workspace-files.js";

const MAX_GROUNDED_REM_FILES = 512;
const MAX_GROUNDED_REM_FILE_BYTES = 1_000_000;
const GROUNDED_REM_SKIPPED_DIRS = new Set([".git", "node_modules"]);

export async function collectMarkdownFiles(
  workspaceDir: string,
  inputPaths: string[],
): Promise<string[]> {
  const found = new Set<string>();
  async function walk(targetPath: string): Promise<void> {
    if (found.size >= MAX_GROUNDED_REM_FILES) {
      return;
    }
    const resolved = path.resolve(targetPath);
    const stat = await inspectWorkspaceFile(workspaceDir, resolved, false);
    if (stat.isSymbolicLink()) {
      return;
    }
    if (stat.isDirectory()) {
      const entries = await listWorkspaceDirectory(workspaceDir, resolved);
      for (const entry of entries) {
        if (entry.isDirectory() && GROUNDED_REM_SKIPPED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(path.join(resolved, entry.name));
      }
      return;
    }
    if (
      stat.isFile() &&
      stat.size <= MAX_GROUNDED_REM_FILE_BYTES &&
      resolved.toLowerCase().endsWith(".md")
    ) {
      found.add(resolved);
    }
  }
  for (const inputPath of inputPaths) {
    const trimmed = inputPath.trim();
    if (!trimmed) {
      continue;
    }
    await walk(trimmed);
  }
  return Array.from(found).toSorted((left, right) => left.localeCompare(right));
}
